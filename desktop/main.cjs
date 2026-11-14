const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const { readFile, stat, writeFile } = require('node:fs/promises')
const { basename, join } = require('node:path')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { Stockfish } = require('./uci.cjs')
const { Chess } = require('chess.js')
const { history } = require('./game-history.cjs')

app.setAppUserModelId('local.shackfish.desktop')
let window
let engine
let comparison
let scouting
const builds = new Map()
let historyPending = false

function createWindow() {
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..')
  window = new BrowserWindow({
    width: 1470, height: 970, minWidth: 940, minHeight: 690,
    title: 'ShackFish',
    backgroundColor: '#171920',
    autoHideMenuBar: true,
    icon: join(__dirname, '../dist/logo.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  })
  Menu.setApplicationMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const stockfish = join(resources, 'engine', 'stockfish.exe')
  builds.set('stockfish', stockfish)
  engine = new Stockfish(stockfish, event => {
    if (window && !window.isDestroyed()) window.webContents.send('engine:event', event)
  })
  window.on('closed', () => {
    engine.dispose()
    comparison?.cancel()
    scouting?.cancel()
    window = null
  })
  window.loadFile(join(__dirname, '../dist/index.html'))
}

ipcMain.handle('engine:analyze', (event, request) => {
  if (event.sender !== window?.webContents) return
  engine.analyze(request)
})
ipcMain.handle('engine:stop', event => {
  if (event.sender === window?.webContents) engine.cancel()
})
ipcMain.handle('pgn:open', async event => {
  if (event.sender !== window?.webContents) return null
  const result = await dialog.showOpenDialog(window, {
    title: 'Open chess games', properties: ['openFile'], filters: [{ name: 'PGN files', extensions: ['pgn', 'txt'] }],
  })
  if (result.canceled) return null
  const path = result.filePaths[0]
  if ((await stat(path)).size > 4_000_000) throw new Error('Choose a PGN smaller than 4 MB.')
  return readFile(path, 'utf8')
})
ipcMain.handle('pgn:save', async (event, pgn) => {
  if (event.sender !== window?.webContents || typeof pgn !== 'string' || pgn.length > 4_000_000) return false
  const result = await dialog.showSaveDialog(window, {
    title: 'Export game as PGN', defaultPath: 'ShackFish-game.pgn', filters: [{ name: 'PGN files', extensions: ['pgn'] }],
  })
  if (result.canceled) return false
  await writeFile(result.filePath, pgn, 'utf8')
  return true
})

ipcMain.handle('history:games', async (event, { site, username, limit, cached }) => {
  if (event.sender !== window?.webContents) return []
  if (!['lichess', 'chesscom'].includes(site) || typeof username !== 'string' ||
      !/^[\w-]{1,40}$/.test(username) || ![100, 300, 600].includes(limit)) throw new Error('Invalid account settings.')
  const file = join(app.getPath('userData'), `history-${site}-${username.toLowerCase()}-${limit}.json`)
  if (cached) {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch { return [] }
  }
  if (historyPending) throw new Error('A history sync is already in progress.')
  historyPending = true
  try {
    const games = await history(site, username, limit)
    await writeFile(file, JSON.stringify(games))
    return games
  } finally {
    historyPending = false
  }
})

ipcMain.handle('autopsy:select', async (event, slot) => {
  if (event.sender !== window?.webContents || !['a', 'b'].includes(slot)) return null
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose a trusted, extracted UCI engine', properties: ['openFile'],
    filters: [{ name: 'Windows engine', extensions: ['exe'] }],
  })
  if (result.canceled) return null
  const file = result.filePaths[0]
  if (!/\.exe$/i.test(file)) throw new Error('Choose a Windows .exe engine.')
  const hash = createHash('sha256')
  for await (const data of createReadStream(file)) hash.update(data)
  builds.set(slot, file)
  return { label: basename(file), sha256: hash.digest('hex') }
})

ipcMain.handle('autopsy:stop', event => {
  if (event.sender === window?.webContents) comparison?.cancel()
})

ipcMain.handle('scouting:stop', event => {
  if (event.sender === window?.webContents) scouting?.cancel()
})

ipcMain.handle('scouting:review', async (event, { fen, moves }) => {
  if (event.sender !== window?.webContents) return null
  if (scouting || !Array.isArray(moves) || moves.length > 600) throw new Error('This game is too long or a review is already running.')
  let complete
  let latest
  const runner = new Stockfish(builds.get('stockfish'), event => {
    if (event.type === 'info') latest = event.info
    else complete(event.type === 'error' ? event : latest)
  })
  const control = { cancelled: false, cancel() { this.cancelled = true; runner.dispose(); complete?.(null) } }
  scouting = control
  try {
    const chess = new Chess(fen)
    const results = []
    for (let index = 0; index <= moves.length; index++) {
      if (control.cancelled) return null
      const turn = chess.turn()
      if (chess.isCheckmate()) results.push({ kind: 'mate', score: 0, blackWins: turn === 'w' })
      else if (chess.isDraw()) results.push({ kind: 'cp', score: 0 })
      else {
        latest = null
        const result = await new Promise(resolve => {
          complete = resolve
          runner.analyze({ id: index, fen, moves: moves.slice(0, index), depth: 8, lines: 1, threads: 1, hash: 32, budget: 60 })
        })
        if (control.cancelled) return null
        if (!result || result.type === 'error') throw new Error(result?.message ?? 'Stockfish returned no evaluation.')
        results.push({ ...result, pv: result.pv.slice(0, 6), score: turn === 'w' ? result.score : -result.score, forced: chess.moves().length === 1 })
      }
      if (index < moves.length) {
        const move = moves[index]
        chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      }
    }
    return results
  } finally {
    runner.dispose()
    scouting = null
  }
})

ipcMain.handle('autopsy:position', async (event, { request, slots }) => {
  if (event.sender !== window?.webContents) return null
  if (comparison || !Array.isArray(slots) || slots.length !== 2 ||
      !['stockfish', 'a'].includes(slots[0]) || slots[1] !== 'b' || !slots.every(slot => builds.has(slot))) {
    throw new Error('Choose both engines and finish the current comparison first.')
  }
  const control = { cancelled: false, cancel: () => { control.cancelled = true } }
  comparison = control
  const search = file => new Promise(resolve => {
    let latest
    const start = Date.now()
    const instance = new Stockfish(file, result => {
      if (result.type === 'info') latest = result.info
      else finish({ ...result, info: latest, elapsed: Date.now() - start })
    })
    function finish(result) {
      control.cancel = () => { control.cancelled = true }
      instance.dispose()
      resolve(result)
    }
    control.cancel = () => {
      control.cancelled = true
      finish(null)
    }
    try {
      instance.analyze({ ...request, id: 1, lines: 1, threads: 1, hash: 64 })
    } catch (error) { finish({ type: 'error', message: error.message }) }
  })
  try {
    const first = await search(builds.get(slots[0]))
    if (control.cancelled) return null
    const second = await search(builds.get(slots[1]))
    return control.cancelled ? null : { first, second }
  } finally {
    comparison = null
  }
})

ipcMain.handle('autopsy:export', async (event, report) => {
  if (event.sender !== window?.webContents || typeof report !== 'string' || report.length > 500000) return false
  const result = await dialog.showSaveDialog(window, {
    title: 'Export Engine Autopsy', defaultPath: 'ShackFish-autopsy.md',
    filters: [{ name: 'Markdown report', extensions: ['md'] }],
  })
  if (result.canceled) return false
  await writeFile(result.filePath, report, 'utf8')
  return true
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
