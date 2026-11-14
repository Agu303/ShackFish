import { createIcons, Activity, ArrowUpDown, ChartNoAxesCombined, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Cpu, Download, FileUp, LayoutGrid, ListOrdered, Palette, Plus, Save, ScanLine, Settings2, X } from 'lucide'
import { Chess } from 'chess.js'
import '@fontsource-variable/inter/wght.css'
import { atPosition, continueGame, loadGames, loadPosition, moveLabel, newGame, playUci, scoreText, scoreValue, terminalScore, uci, whiteScore } from './chess-state.mjs'
import { followLine } from './game-tree.mjs'
import { classifications, summarizeReview } from './game-review.mjs'
import { explainMove } from './shackfish-coach.mjs'
import { hideReaction, onReactionDismiss, reserveReactionSpace, showReaction } from './board-reaction.mjs'
import { setupScouting } from './scouting.mjs'
import { setupAutopsy } from './engine-autopsy.mjs'
import openingBook from './assets/opening-book.json'
import './style.css'

const icons = { Activity, ArrowUpDown, ChartNoAxesCombined, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Cpu, Download, FileUp, LayoutGrid, ListOrdered, Palette, Plus, Save, ScanLine, Settings2, X }
const pieces = import.meta.glob('./assets/pieces/*.svg', { eager: true, query: '?url', import: 'default' })
const pieceUrl = (color, type) => pieces[`./assets/pieces/${color}${type.toUpperCase()}.svg`]
const pieceName = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const $ = id => document.getElementById(id)
const engine = window.shackfish
const files = [...'abcdefgh']
const ranks = [...'87654321']
const boardCells = new Map()
const reviewCache = new WeakMap()
const defaults = { depth: 17, lines: 3, threads: 2, hash: 64, reviewDepth: 12 }
const defaultColors = { light: '#dbd7ed', dark: '#797292', highlight: '#a599ff' }
const storageKey = 'shackfish-workspace-v1'
const maxStoredPgn = 2_500_000
let toastTimer
let showStorageWarning = true
let settings = { ...defaults }
let colors = { ...defaultColors }
let coachEnabled = true
let profanity = 3
let dismissedReaction
const coachCache = new WeakMap()
let library = []
let imports = []
let game = newGame()
let line = followLine(game.tree)
let experiments = []
let ply = 0
let flipped = false
let live = true
let selected
let dragSquare
let destinations = []
let chess
let requestId = Date.now() * 1000
let delay
let review
let liveLines = new Map()
let status = 'Starting engine'
let applyPrompt
let alternatePrompt
let interfaceSize = { text: 100, buttons: 100 }
let page = 'board'
let practice

const criticalLabels = new Set(['Inaccuracy', 'Mistake', 'Miss', 'Blunder'])

function criticalMoves() {
  const results = gameReview()
  if (!results?.length || review) return []
  return summarizeReview(game, results, openingBook).moves.flatMap((move, index) =>
    criticalLabels.has(move.label) && results[index].pv?.[0] ? [{ ...move, index }] : [])
}

function switchPage(next, refreshAnalysis = true) {
  if (page === next) return
  page = next
  $('board-workspace').hidden = next !== 'board'
  $('scout-page').hidden = next !== 'scout'
  $('engines-page').hidden = next !== 'engines'
  document.querySelector('.top-actions').hidden = next !== 'board'
  for (const name of ['board', 'scout', 'engines']) {
    if (name === next) $(name + '-tab').setAttribute('aria-current', 'page')
    else $(name + '-tab').removeAttribute('aria-current')
  }
  if (next === 'board') {
    $('game-title').textContent = game.title
    if (refreshAnalysis && !review) queueAnalysis()
  } else {
    $('game-title').textContent = next === 'scout' ? 'Personal Scouting Report' : 'Engine Autopsy'
    if (!review) {
      clearTimeout(delay)
      ++requestId
      engine?.stop()
    }
  }
}

function startPractice() {
  const summary = summarizeReview(game, gameReview(), openingBook)
  openPrompt('Retry my mistakes', '<label>Which side did you play?<select id="retry-side"><option value="w">White</option><option value="b">Black</option><option value="both">Both sides</option></select></label>', 'Start practice', () => {
    const side = $('retry-side').value
    const entries = criticalMoves().filter(move => side === 'both' || game.moves[move.index].color === side)
    if (!entries.length) throw new Error('There are no reviewed mistakes for that side.')
    practice = { entries, step: 0, correct: 0, returnPly: ply, returnPath: line.path, flipped }
    showRetry()
  })
  const white = game.headers.White || 'White'
  const black = game.headers.Black || 'Black'
  $('retry-side').options[0].textContent = `White · ${white} (${summary.moves.filter((m, i) => criticalLabels.has(m.label) && game.moves[i].color === 'w').length})`
  $('retry-side').options[1].textContent = `Black · ${black} (${summary.moves.filter((m, i) => criticalLabels.has(m.label) && game.moves[i].color === 'b').length})`
}

function showRetry() {
  const entry = practice.entries[practice.step]
  if (!entry) return endPractice(true)
  practice.answered = false
  flipped = game.moves[entry.index].color === 'b'
  buildBoard()
  goTo(entry.index, [])
  $('retry-title').textContent = `Retry ${practice.step + 1} / ${practice.entries.length} · ${chess.turn() === 'w' ? 'White' : 'Black'} to move`
  $('retry-feedback').textContent = 'Find Stockfish’s move. The board is yours.'
  $('retry-reveal').disabled = $('retry-next').disabled = false
}

function attemptRetry(move) {
  if (practice.answered || !move) return
  const { index } = practice.entries[practice.step]
  if (move === gameReview()[index].pv[0]) {
    practice.correct++
    revealRetry(true)
  } else {
    clearSelection()
    paintBoard()
    $('retry-feedback').textContent = 'That wasn’t Stockfish’s pick. Take another shot or reveal the answer.'
  }
}

function revealRetry(correct = false) {
  if (practice.answered) return
  practice.answered = true
  const { index, label } = practice.entries[practice.step]
  const results = gameReview()
  const best = playUci(atPosition(game, index), results[index].pv[0])
  const explanation = explainMove(game.moves[index], results[index], results[index + 1], label)
  $('retry-reveal').disabled = true
  clearSelection()
  paintBoard()
  $('retry-feedback').textContent = `${correct ? 'Nailed it.' : 'Stockfish picks'} ${best.san}. Originally you played ${game.moves[index].san}.`
  if (coachEnabled && explanation) {
    reserveReactionSpace(true)
    showReaction(explanation, flipped, profanity)
  }
}

function endPractice(completed = false) {
  if (!practice) return
  const { returnPly, returnPath, flipped: originalFlip, correct, entries } = practice
  practice = null
  flipped = originalFlip
  buildBoard()
  goTo(returnPly, returnPath)
  if (completed) toast(`Practice complete. Found ${correct} of ${entries.length} engine moves.`)
}

function journalDialog() {
  const key = line.moves.slice(0, ply).map(uci).join(' ')
  const context = ply ? moveLabel(line.moves[ply - 1]) : 'Starting position'
  openPrompt('Decision journal', '<p id="journal-context"></p><label for="journal-note">What did you see? What were you trying to do?</label><textarea id="journal-note" rows="6" maxlength="1800"></textarea><p>Use Save game in the top right to keep this entry with the game.</p>', 'Apply note', () => {
    const journal = { ...game.journal }
    const note = $('journal-note').value.trim()
    if (note) journal[key] = note
    else delete journal[key]
    const updated = { ...game, journal }
    if (reviewCache.has(game)) reviewCache.set(updated, reviewCache.get(game))
    game = updated
    imports = imports.map(item => item.id === game.id ? game : item)
    renderReview()
  })
  $('journal-context').textContent = context
  $('journal-note').value = game.journal?.[key] ?? ''
}

function applyInterfaceSize() {
  for (const [key, value] of Object.entries(interfaceSize)) {
    document.documentElement.style.setProperty(`--${key}-scale`, value / 100)
  }
}

function interfaceDialog() {
  openPrompt('Interface settings', `<div class="settings-grid">${Object.entries(interfaceSize).map(([key, current]) =>
    `<label>${key === 'text' ? 'Text size' : 'Button size'}<select id="size-${key}">${[90, 100, 115, 130].map(size =>
      `<option value="${size}" ${size === current ? 'selected' : ''}>${size}%</option>`).join('')}</select></label>`).join('')}</div>`, 'Save settings', () => {
    for (const key of Object.keys(interfaceSize)) interfaceSize[key] = Number($('size-' + key).value)
    applyInterfaceSize()
    persist()
  })
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey))
    if (!saved) return
    settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
      [key, Number.isInteger(saved.settings?.[key]) ? saved.settings[key] : value]))
    colors = Object.fromEntries(Object.entries(defaultColors).map(([key, value]) =>
      [key, /^#[\da-f]{6}$/i.test(saved.colors?.[key]) ? saved.colors[key] : value]))
    library = saved.games.map(item => ({
      ...newGame(item.pgn, item.title), id: item.id, reviewResults: item.reviewResults, journal: item.journal,
    }))
    game = library.find(item => item.id === saved.active) ?? game
    line = followLine(game.tree, Array.isArray(saved.path) ? saved.path : [])
    ply = Math.max(0, Math.min(line.moves.length, Number(saved.ply) || 0))
    flipped = saved.flipped === true
    live = saved.live !== false
    coachEnabled = saved.coachEnabled !== false
    if ([1, 2, 3, 4, 5].includes(saved.profanity)) profanity = saved.profanity
    for (const key of Object.keys(interfaceSize)) {
      if ([90, 100, 115, 130].includes(saved.interfaceSize?.[key])) interfaceSize[key] = saved.interfaceSize[key]
    }
  } catch {
    library = []
  }
}

function persist(entries = library) {
  try {
    const games = entries.map(({ id, pgn, title, reviewResults, journal }) => ({ id, pgn, title, reviewResults, journal }))
    if (games.reduce((size, item) => size + item.pgn.length, 0) > maxStoredPgn) throw new Error('Library capacity')
    const currentSaved = entries.some(item => item.id === game.id && item.pgn === game.pgn)
    localStorage.setItem(storageKey, JSON.stringify({
      games, settings, colors, active: game.id, ply: practice?.returnPly ?? ply,
      path: currentSaved ? (practice?.returnPath ?? line.path).slice(0, practice?.returnPly ?? ply) : [],
      flipped: practice?.flipped ?? flipped, live,
      coachEnabled, profanity, interfaceSize,
    }))
    showStorageWarning = true
    return true
  } catch {
    if (entries !== library || showStorageWarning) toast('The local library is full or unavailable. Export PGN to keep this game.')
    showStorageWarning = false
    return false
  }
}

function saveGame() {
  const results = gameReview()
  const saved = {
    ...game,
    reviewResults: results?.map(({ kind, score, blackWins, pv, forced }) => ({ kind, score, blackWins, pv: pv?.slice(0, 6), forced })),
  }
  const index = library.findIndex(item => item.id === game.id)
  const entries = [...library]
  if (index < 0) entries.unshift(saved)
  else entries[index] = saved
  if (!persist(entries)) return
  library = entries
  imports = imports.filter(item => item.id !== saved.id)
  game = saved
  experiments = []
  renderLibrary()
  renderReview()
  toast('Game saved to library.')
}

function gameReview() {
  return reviewCache.get(game) ?? game.reviewResults
}

function startNewBoard() {
  imports = []
  showGame(newGame(), 0)
}

function toast(message) {
  clearTimeout(toastTimer)
  $('toast').textContent = message
  $('toast').hidden = false
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 4200)
}

function buildBoard() {
  const fragment = document.createDocumentFragment()
  const boardFiles = flipped ? [...files].reverse() : files
  const boardRanks = flipped ? [...ranks].reverse() : ranks
  boardCells.clear()
  boardRanks.forEach((rank, y) => boardFiles.forEach((file, x) => {
    const square = file + rank
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.dataset.square = square
    cell.className = `square ${(x + y) % 2 ? 'dark' : 'light'}`
    if (x === 0) cell.dataset.rank = rank
    if (y === 7) cell.dataset.file = file
    cell.addEventListener('click', () => clickSquare(square))
    cell.addEventListener('dragstart', event => {
      const piece = event.target
      if (!(piece instanceof HTMLImageElement) || !piece.draggable) return event.preventDefault()
      const bounds = piece.getBoundingClientRect()
      event.dataTransfer.setDragImage(piece, bounds.width / 2, bounds.height / 2)
      event.dataTransfer.setData('text/plain', square)
      event.dataTransfer.effectAllowed = 'move'
      dragSquare = square
      choose(square)
      requestAnimationFrame(() => {
        if (dragSquare === square) piece.classList.add('drag-source')
      })
    })
    cell.addEventListener('dragover', event => {
      if (destinations.some(move => move.to === square)) event.preventDefault()
    })
    cell.addEventListener('drop', event => {
      event.preventDefault()
      if (dragSquare && event.dataTransfer.getData('text/plain') === dragSquare) clickSquare(square)
    })
    fragment.append(cell)
    boardCells.set(square, cell)
  }))
  $('board').replaceChildren(fragment)
}

function clearSelection() {
  if (dragSquare) boardCells.get(dragSquare)?.querySelector('img')?.classList.remove('drag-source')
  dragSquare = undefined
  selected = undefined
  destinations = []
}

function choose(square) {
  selected = square
  destinations = chess.moves({ square, verbose: true })
  paintBoard()
}

function clickSquare(square) {
  const options = destinations.filter(move => move.to === square)
  if (options.length === 1) return play([uci(options[0])])
  if (options.length > 1) return openPromotion(options)
  if (square !== selected && chess.get(square)?.color === chess.turn()) return choose(square)
  clearSelection()
  paintBoard()
}

function paintBoard() {
  const last = line.moves[ply - 1]
  const legal = new Set(destinations.map(move => move.to))
  for (const [square, cell] of boardCells) {
    const piece = chess.get(square)
    const key = piece ? piece.color + piece.type : ''
    if (cell.dataset.piece !== key) {
      cell.replaceChildren()
      if (piece) {
        const img = document.createElement('img')
        img.src = pieceUrl(piece.color, piece.type)
        img.alt = ''
        img.draggable = false
        img.addEventListener('dragend', () => {
          clearSelection()
          paintBoard()
        })
        cell.append(img)
      }
      cell.dataset.piece = key
    }
    if (piece) cell.firstElementChild.draggable = piece.color === chess.turn()
    cell.setAttribute('aria-label', piece ? `${square}, ${piece.color === 'w' ? 'White' : 'Black'} ${pieceName[piece.type]}` : square)
    cell.classList.toggle('selected', square === selected)
    cell.classList.toggle('last-move', square === last?.from || square === last?.to)
    cell.classList.toggle('legal', legal.has(square))
    cell.classList.toggle('capture', legal.has(square) && !!piece)
    cell.classList.toggle('in-check', piece?.type === 'k' && piece.color === chess.turn() && chess.isCheck())
  }
}

function showGame(item, index) {
  if (practice) endPractice()
  switchPage('board', false)
  stopReview()
  experiments = []
  dismissedReaction = undefined
  game = item
  line = followLine(game.tree)
  goTo(index)
}

function goTo(index, path = line.path) {
  while (experiments.length) {
    const { original, branch } = experiments.at(-1)
    if (index >= branch.length && branch.every((choice, depth) => choice === (path[depth] ?? 0))) break
    if (reviewCache.has(game)) reviewCache.set(original, reviewCache.get(game))
    game = original
    experiments.pop()
  }
  line = followLine(game.tree, path)
  ply = Math.max(0, Math.min(index, line.moves.length))
  chess = atPosition({ ...game, moves: line.moves }, ply)
  clearSelection()
  paintBoard()
  renderGame()
  cueCoach()
  persist()
  if (review) renderAnalysis()
  else queueAnalysis()
}

function play(moves) {
  if (practice) return attemptRetry(moves[0])
  try {
    const next = atPosition({ ...game, moves: line.moves }, ply)
    moves.forEach(move => playUci(next, move))
    const { game: updated, path, fork } = continueGame(game, line.path.slice(0, ply), next)
    if (updated !== game) {
      if (updated.moves.length !== game.moves.length) stopReview()
      else if (reviewCache.has(game)) reviewCache.set(updated, reviewCache.get(game))
      if (fork !== undefined) experiments.push({ original: game, branch: path.slice(0, fork + 1) })
      if (!experiments.length) imports = imports.map(item => item.id === updated.id ? updated : item)
      game = updated
    }
    goTo(path.length, path)
  } catch (error) {
    toast(error.message)
  }
}

function choosePlayer(element, color) {
  const isWhite = color === 'w'
  element.replaceChildren()
  const icon = document.createElement('img')
  icon.src = pieceUrl(color, 'k')
  icon.alt = ''
  const name = document.createElement('strong')
  const savedName = game.headers[isWhite ? 'White' : 'Black']
  name.textContent = savedName && savedName !== '?' ? savedName : isWhite ? 'White' : 'Black'
  element.append(icon, name)
  if (chess.turn() === color) {
    const turn = document.createElement('span')
    turn.textContent = chess.isCheckmate() ? 'Checkmate' : chess.isDraw() ? 'Draw' : chess.isCheck() ? 'In check' : 'To move'
    turn.className = 'turn'
    element.append(turn)
  }
}

function renderGame() {
  $('game-title').textContent = game.title
  choosePlayer($('player-top'), flipped ? 'w' : 'b')
  choosePlayer($('player-bottom'), flipped ? 'b' : 'w')
  $('ply-label').textContent = ply ? moveLabel(line.moves[ply - 1]) : 'Starting position'
  for (const key of ['first', 'prev']) $(key).disabled = !ply
  for (const key of ['next', 'last']) $(key).disabled = ply === line.moves.length
  renderLibrary()
  renderMoves()
  renderReview()
}

function renderLibrary() {
  $('imports').hidden = imports.length === 0
  $('import-list').replaceChildren(...imports.map(item => {
    const button = document.createElement('button')
    button.className = 'import-item'
    button.textContent = item.title
    button.title = item.title
    if (item.id === game.id) button.setAttribute('aria-current', 'true')
    button.onclick = () => {
      if (game.id === item.id) return
      showGame(item, 0)
      if (engine && game.moves.length && !gameReview()?.length) startReview()
    }
    return button
  }))
  const list = $('library')
  if (!library.length) {
    const empty = document.createElement('p')
    empty.className = 'library-empty'
    empty.textContent = 'Use Save game to add a board to your library.'
    list.replaceChildren(empty)
    return
  }
  const entries = library.map(item => {
    const row = document.createElement('div')
    row.className = `library-entry${item.id === game.id ? ' active' : ''}`
    const button = document.createElement('button')
    button.className = 'library-item'
    button.title = item.title
    button.textContent = item.title
    button.onclick = () => showGame(item, 0)
    const remove = document.createElement('button')
    remove.className = 'remove-game'
    remove.textContent = '×'
    remove.title = `Remove ${item.title} from library`
    remove.setAttribute('aria-label', remove.title)
    remove.onclick = () => openPrompt('Remove game?', '<p>This removes the game from your local library.</p>', 'Remove', () => {
      library = library.filter(entry => entry.id !== item.id)
      if (game.id === item.id) showGame(newGame(), 0)
      else renderLibrary()
      persist()
    })
    row.append(button, remove)
    return row
  })
  list.replaceChildren(...entries)
}

function renderMoves() {
  const list = $('move-list')
  const report = summarizeReview(game, gameReview(), openingBook)
  renderAnnotation(report.moves)
  if (!game.moves.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Make a move on the board or import a PGN.'
    list.replaceChildren(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  const isSelected = path => ply === path.length && path.every((choice, index) => choice === line.path[index])
  const buttonFor = (node, path, mainIndex) => {
    const button = document.createElement('button')
    const main = mainIndex !== undefined
    const rating = main ? report.moves[mainIndex] : null
    button.textContent = (main ? node.move.san : moveLabel(node.move)) + (rating ? ` ${classifications[rating.label]}` : '')
    if (rating) {
      button.classList.add(rating.label.toLowerCase())
      button.title = rating.label
    }
    if (main ? ply === mainIndex + 1 && !line.path.slice(0, ply).some(Boolean) : isSelected(path)) {
      button.setAttribute('aria-current', 'step')
    }
    button.onclick = main ? () => goTo(mainIndex + 1, []) : () => goTo(path.length, path)
    return button
  }
  const variation = (node, path) => {
    const branch = document.createElement('div')
    branch.className = 'move-branch'
    branch.setAttribute('aria-label', `Variation beginning with ${moveLabel(node.move)}`)
    while (node) {
      branch.append(buttonFor(node, path))
      node.children.slice(1).forEach((child, i) => branch.append(variation(child, [...path, i + 1])))
      node = node.children[0]
      path = [...path, 0]
    }
    return branch
  }
  let row
  let parent = game.tree
  game.moves.forEach((move, index) => {
    const node = parent.children[0]
    const prefix = parent.children.length > 1 ? Array(index).fill(0) : null
    const number = move.before.split(' ')[5]
    if (!row || move.color === 'w') {
      row = document.createElement('div')
      row.className = 'move-row'
      const label = document.createElement('span')
      label.textContent = number + '.'
      row.append(label)
      if (move.color === 'b') row.append(document.createElement('span'))
      fragment.append(row)
    }
    const button = buttonFor(node, null, index)
    row.append(button)
    if (prefix) {
      parent.children.slice(1).forEach((child, i) => fragment.append(variation(child, [...prefix, i + 1])))
      row = null
    }
    parent = node
  })
  const top = list.scrollTop
  list.replaceChildren(fragment)
  list.scrollTop = top
  const current = list.querySelector('[aria-current]')
  if (current) {
    const outer = list.getBoundingClientRect()
    const inner = current.getBoundingClientRect()
    if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom
    if (inner.top < outer.top) list.scrollTop -= outer.top - inner.top
  }
}

function renderAnnotation(annotations) {
  const element = $('move-annotation')
  const item = line.path.slice(0, ply).some(Boolean) ? null : annotations[ply - 1]
  element.hidden = !item
  element.replaceChildren()
  if (!item) return
  const label = document.createElement('strong')
  label.className = item.label.toLowerCase()
  label.textContent = item.label
  const detail = document.createElement('span')
  detail.textContent = item.label === 'Book' ? 'In the opening book'
    : item.label === 'Forced' ? 'Only one legal move'
    : item.label === 'Brilliant' ? 'Engine-approved material sacrifice'
    : item.best ? 'Stockfish’s top choice'
    : `${item.loss.toFixed(1)} pp estimated win-chance loss`
  element.append(label, detail)
}

function renderSummary(results) {
  const summary = $('review-summary')
  summary.hidden = results?.length !== game.moves.length + 1 || !game.moves.length
  summary.replaceChildren()
  if (summary.hidden) return
  const { players } = summarizeReview(game, results, openingBook)
  for (const [color, player] of Object.entries(players)) {
    const side = color === 'w' ? 'White' : 'Black'
    const name = game.headers[side]
    const card = document.createElement('div')
    card.className = 'review-player'
    const title = document.createElement('strong')
    title.textContent = name && name !== '?' ? name : side
    card.append(title)
    for (const [label, value] of [
      ['Accuracy', player.accuracy === undefined ? '—' : `${player.accuracy.toFixed(1)}%`],
      ['Est. rating', player.rating === undefined ? '—' : `≈${player.rating}`],
    ]) {
      const metric = document.createElement('div')
      metric.className = 'review-metric'
      const descriptor = document.createElement('span')
      descriptor.textContent = label
      const figure = document.createElement('b')
      figure.textContent = value
      metric.append(descriptor, figure)
      card.append(metric)
    }
    const counts = document.createElement('div')
    counts.className = 'review-counts'
    for (const label of Object.keys(classifications)) {
      if (!player.counts[label]) continue
      const count = document.createElement('span')
      count.className = label.toLowerCase()
      count.title = label
      count.setAttribute('aria-label', `${label}: ${player.counts[label]}`)
      count.textContent = `${classifications[label]} ${player.counts[label]}`
      counts.append(count)
    }
    card.append(counts)
    summary.append(card)
  }
  const note = document.createElement('small')
  note.textContent = 'Ratings are rough single-game estimates. Book and forced moves are excluded from accuracy. A rating needs at least five scored moves.'
  summary.append(note)
}

function cueCoach() {
  const onMainLine = !line.path.slice(0, ply).some(Boolean)
  if (!onMainLine || dismissedReaction?.game !== game || dismissedReaction?.ply !== ply) dismissedReaction = undefined
  const results = gameReview()
  const ready = coachEnabled && !practice && !review && results?.length === game.moves.length + 1 && game.moves.length > 0
  reserveReactionSpace(ready)
  if (!ready || !ply || dismissedReaction || !onMainLine) return hideReaction()
  let cached = coachCache.get(game)
  if (cached?.results !== results) {
    const { moves } = summarizeReview(game, results, openingBook)
    cached = { results, moves, explanations: new Map() }
    coachCache.set(game, cached)
  }
  if (!cached.explanations.has(ply)) {
    cached.explanations.set(ply, explainMove(game.moves[ply - 1], results[ply - 1], results[ply], cached.moves[ply - 1].label))
  }
  const info = cached.explanations.get(ply)
  if (info) showReaction(info, flipped, profanity)
  else hideReaction()
}

function renderReview() {
  const graph = $('review-graph')
  const results = gameReview()
  renderSummary(results)
  const saved = library.includes(game) && !reviewCache.has(game)
  $('save-game').disabled = saved || !game.pgn || !!review
  $('save-game').querySelector('span').textContent = saved ? 'Saved' : 'Save game'
  $('review').disabled = !game.moves.length || !engine
  $('review').querySelector('span').textContent = review ? 'Cancel review' : results?.length === game.moves.length + 1 ? 'Rerun review' : 'Review game'
  const critical = criticalMoves()
  $('quick-review').disabled = !!review || !game.moves.length || !engine
  $('prev-critical').disabled = !critical.some(move => move.index + 1 < ply)
  $('next-critical').disabled = !critical.some(move => move.index + 1 > ply)
  $('worst-move').disabled = $('retry-mistakes').disabled = !critical.length
  $('board-workspace').classList.toggle('practicing', !!practice)
  $('decision-journal').textContent = game.journal?.[line.moves.slice(0, ply).map(uci).join(' ')] ? 'Decision journal •' : 'Decision journal'
  $('decision-journal').disabled = !!review || line.path.slice(0, ply).some(Boolean)
  $('retry-panel').hidden = !practice
  for (const id of ['save-game', 'export']) $(id).hidden = !!practice
  graph.hidden = !results?.length && !review
  graph.replaceChildren()
  if (graph.hidden) return
  const bar = document.createElement('div')
  bar.className = 'review-meta'
  bar.textContent = review ? `${review.quick ? 'Quick review' : 'Analyzing'} · ${results.length} / ${game.moves.length + 1} positions` : `${results.length} / ${game.moves.length + 1} positions reviewed`
  graph.append(bar)
  if (!results.length) return
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 320 70')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-label', 'White’s evaluation by move')
  const x = index => 5 + 310 * index / Math.max(1, game.moves.length)
  const y = value => 35 - 29 * Math.tanh(scoreValue(value) / 420)
  for (const [tag, attrs] of [
    ['line', { x1: 0, x2: 320, y1: 35, y2: 35, class: 'graph-axis' }],
    ['polyline', { points: results.map((value, index) => `${x(index)},${y(value)}`).join(' '), class: 'graph-line' }],
    ...(line.path.slice(0, ply).some(Boolean) ? [] : [['line', { x1: x(ply), x2: x(ply), y1: 0, y2: 70, class: 'graph-marker' }]]),
  ]) {
    const node = document.createElementNS(ns, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    svg.append(node)
  }
  svg.onclick = event => {
    const bounds = svg.getBoundingClientRect()
    goTo(Math.round(((event.clientX - bounds.left) / bounds.width * 320 - 5) / 310 * game.moves.length), [])
  }
  graph.append(svg)
}

function queueAnalysis() {
  clearTimeout(delay)
  const id = ++requestId
  engine?.stop()
  liveLines = new Map()
  const terminal = terminalScore(chess)
  status = terminal ? (terminal.kind === 'mate' ? 'Checkmate' : 'Draw') : !live || practice ? 'Live analysis paused' : engine ? 'Analyzing position…' : 'Open the desktop app to analyze'
  renderAnalysis()
  if (engine && live && !terminal && !practice && page === 'board') {
    delay = setTimeout(() => request(id, ply), 100)
  }
}

function request(id, index, forReview = false) {
  engine.analyze({
    id, fen: game.start, moves: (forReview ? game.moves : line.moves).slice(0, index).map(uci),
    lines: forReview ? 1 : settings.lines, depth: forReview ? (review.quick ? Math.min(9, settings.reviewDepth) : settings.reviewDepth) : settings.depth,
    budget: forReview && review.quick ? 100 : undefined,
    threads: settings.threads, hash: settings.hash, review: forReview,
  }).catch(error => receive({ id, type: 'error', message: error.message }))
}

function receive(event) {
  if (event.id !== requestId) return
  if (event.name) $('engine-name').textContent = event.name
  if (review) {
    if (event.type === 'info' && event.info.rank === 1) {
      review.score = { ...whiteScore(event.info, review.turn), forced: review.forced }
    } else if (event.type === 'done' && review.score) {
      reviewCache.get(game).push(review.score)
      review.index++
      renderMoves()
      renderReview()
      advanceReview()
    } else if (event.type === 'error' || event.type === 'done') {
      toast(event.message ?? 'Stockfish returned no evaluation for this position.')
      stopReview()
      queueAnalysis()
    }
    return
  }
  if (event.type === 'info') liveLines.set(event.info.rank, whiteScore(event.info, chess.turn()))
  if (event.type === 'done') status = liveLines.size ? 'Search complete' : 'No analysis returned'
  if (event.type === 'error') status = event.message
  renderAnalysis()
}

function renderAnalysis() {
  const top = liveLines.get(1)
  const score = top ?? terminalScore(chess)
  $('score').textContent = scoreText(score)
  $('evaluation').textContent = score ? 'White’s perspective' : 'Position evaluation'
  const fraction = score ? (1 + Math.tanh(scoreValue(score) / 380)) / 2 : 0.5
  $('eval-fill').style.height = `${fraction * 100}%`
  $('eval-fill').style.bottom = flipped ? 'auto' : '0'
  $('eval-fill').style.top = flipped ? '0' : 'auto'
  $('live').setAttribute('aria-checked', String(live))
  $('engine-status').textContent = top ? `Depth ${top.depth} · ${status}` : status
  const container = $('engine-lines')
  const rows = Array.from(liveLines.values()).sort((a, b) => a.rank - b.rank).map(line => {
    const position = new Chess(chess.fen())
    const labels = []
    const moves = []
    for (const move of line.pv.slice(0, 8)) {
      try {
        const played = playUci(position, move)
        labels.push(played.color === 'w' || !labels.length ? moveLabel(played) : played.san)
        moves.push(move)
      } catch { break }
    }
    const row = document.createElement('div')
    row.className = 'variation'
    const rating = document.createElement('strong')
    rating.textContent = scoreText(line)
    const suggestion = document.createElement('button')
    suggestion.className = 'variation-move'
    suggestion.textContent = labels.shift() ?? '—'
    suggestion.title = 'Play suggested move'
    suggestion.disabled = !moves.length
    suggestion.onclick = () => play(moves.slice(0, 1))
    const continuation = document.createElement('span')
    continuation.textContent = labels.join(' ')
    continuation.title = continuation.textContent
    const action = document.createElement('button')
    action.className = 'play-line'
    action.textContent = '↗'
    action.title = 'Play this line'
    action.setAttribute('aria-label', `Play line ${line.rank}`)
    action.disabled = !moves.length
    action.onclick = () => play(moves)
    row.append(rating, suggestion, continuation, action)
    return row
  })
  if (!rows.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = review ? 'Game review is using the engine.' : score ? 'This game has ended.' : live ? 'Suggested moves appear here.' : 'Turn on live analysis to see suggestions.'
    rows.push(empty)
  }
  container.replaceChildren(...rows)
}

function startReview(quick = false) {
  clearTimeout(delay)
  engine.stop()
  ++requestId
  liveLines = new Map()
  status = 'Reviewing game…'
  review = { index: 0, quick }
  dismissedReaction = undefined
  cueCoach()
  reviewCache.set(game, [])
  renderAnalysis()
  renderMoves()
  renderReview()
  advanceReview()
}

function advanceReview() {
  const results = reviewCache.get(game)
  while (review.index <= game.moves.length) {
    const position = atPosition(game, review.index)
    const terminal = terminalScore(position)
    if (!terminal) {
      review.score = null
      review.turn = position.turn()
      review.forced = position.moves().length === 1
      return request(++requestId, review.index, true)
    }
    results.push(terminal)
    review.index++
  }
  review = null
  renderMoves()
  renderReview()
  queueAnalysis()
  toast('Game review complete.')
  cueCoach()
}

function stopReview() {
  if (!review) return
  review = null
  ++requestId
  engine.stop()
  renderReview()
}

function openPrompt(title, markup, submit, apply, alternate, action) {
  $('prompt-title').textContent = title
  $('prompt-body').innerHTML = markup
  $('prompt-error').hidden = true
  $('prompt-submit').hidden = !submit
  $('prompt-submit').textContent = submit
  $('prompt-alt').hidden = !alternate
  $('prompt-alt').textContent = alternate
  applyPrompt = apply
  alternatePrompt = action
  $('prompt').showModal()
}

function promptError(error) {
  $('prompt-error').textContent = error.message
  $('prompt-error').hidden = false
}

function openPromotion(options) {
  openPrompt('Promote pawn', '<div id="promotion-options"></div>', '', null)
  for (const move of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'button'
    button.title = pieceName[move.promotion]
    const img = document.createElement('img')
    img.src = pieceUrl(move.color, move.promotion)
    img.alt = pieceName[move.promotion]
    button.onclick = () => { $('prompt').close(); play([uci(move)]) }
    button.append(img)
    $('promotion-options').append(button)
  }
}

function importText(text) {
  imports = loadGames(text)
  showGame(imports[0], 0)
  toast(`Opened ${imports.length} ${imports.length === 1 ? 'game' : 'games'}.`)
  if (engine && game.moves.length) startReview()
}

function importDialog() {
  openPrompt('Import PGN', '<label for="pgn-input">Paste PGN</label><textarea id="pgn-input" rows="8" placeholder="1. e4 e5 2. Nf3 Nc6 …"></textarea>', 'Import games',
    () => importText($('pgn-input').value), 'Open PGN file', async () => {
      if (!engine) {
        $('pgn-file').click()
        return false
      }
      const text = await engine.openPgn()
      if (text === null) return false
      importText(text)
    })
}

function settingsDialog() {
  openPrompt('Engine settings', `<div class="settings-grid">${[
    ['depth', 'Live depth', 6, 30], ['lines', 'Suggested lines', 1, 5], ['threads', 'CPU threads', 1, 16],
    ['hash', 'Hash memory (MB)', 16, 512], ['reviewDepth', 'Review depth', 6, 30],
  ].map(([key, name, min, max]) => `<label>${name}<input id="setting-${key}" type="number" min="${min}" max="${max}" value="${settings[key]}" required></label>`).join('')}</div><p>Live searches run for up to 12 seconds. Review uses one line per position and up to 1.5 seconds each.</p>
    <fieldset class="coach-settings"><legend>Shackfish coach</legend><label class="coach-toggle"><input id="setting-coach" type="checkbox" ${coachEnabled ? 'checked' : ''}> Show Shackfish during game review</label>
    <label for="setting-profanity">Profanity level <output id="profanity-value">${profanity}</output></label>
    <input id="setting-profanity" type="range" min="1" max="5" step="1" value="${profanity}">
    <div class="slider-labels"><span>1 · PG-13</span><span>5 · Full sailor</span></div></fieldset>`, 'Save settings', () => {
    const next = Object.fromEntries(Object.keys(defaults).map(key => [key, $('setting-' + key).valueAsNumber]))
    if (Object.keys(defaults).some(key => next[key] !== settings[key])) {
      settings = next
      stopReview()
      queueAnalysis()
    }
    coachEnabled = $('setting-coach').checked
    profanity = $('setting-profanity').valueAsNumber
    dismissedReaction = undefined
    persist()
    cueCoach()
  })
  $('setting-profanity').oninput = event => { $('profanity-value').textContent = event.target.value }
}

function applyColors() {
  for (const [key, color] of Object.entries(colors)) {
    document.documentElement.style.setProperty(`--board-${key}`, color)
  }
}

function colorDialog() {
  const fields = { light: 'Light squares', dark: 'Dark squares', highlight: 'Move highlight' }
  openPrompt('Board colors', `<div class="settings-grid">${Object.entries(fields).map(([key, label]) =>
    `<label>${label}<input id="color-${key}" type="color" value="${colors[key]}"></label>`).join('')}</div>`,
  'Save colors', () => {
    colors = Object.fromEntries(Object.keys(fields).map(key => [key, $('color-' + key).value]))
    applyColors()
    persist()
  }, 'Reset colors', () => {
    for (const [key, color] of Object.entries(defaultColors)) $('color-' + key).value = color
    return false
  })
}

const file = document.createElement('input')
file.id = 'pgn-file'
file.type = 'file'
file.accept = '.pgn,.txt'
file.hidden = true
file.onchange = async () => {
  try {
    if (!file.files.length) return
    if (file.files[0].size > 4_000_000) throw new Error('Choose a PGN smaller than 4 MB.')
    importText(await file.files[0].text())
    $('prompt').close()
  } catch (error) { promptError(error) }
  finally { file.value = '' }
}
document.body.append(file)

$('prompt-form').onsubmit = async event => {
  event.preventDefault()
  try {
    if (applyPrompt && await applyPrompt() !== false) $('prompt').close()
  } catch (error) { promptError(error) }
}
$('prompt-alt').onclick = async () => {
  try {
    if (alternatePrompt && await alternatePrompt() !== false) $('prompt').close()
  } catch (error) { promptError(error) }
}
$('close-prompt').onclick = () => $('prompt').close()
$('new-game').onclick = startNewBoard
$('import-game').onclick = importDialog
$('load-fen').onclick = () => openPrompt('Load position', '<label for="fen-input">FEN</label><input id="fen-input" placeholder="Paste a FEN string" required>', 'Load position', () => {
  showGame(loadPosition($('fen-input').value), 0)
})
$('board-colors').onclick = colorDialog
$('save-game').onclick = saveGame
$('flip').onclick = () => {
  flipped = !flipped
  buildBoard()
  paintBoard()
  renderGame()
  renderAnalysis()
  cueCoach()
  persist()
}
$('export').onclick = async () => {
  try {
    const pgn = game.pgn || chess.pgn()
    if (engine) {
      if (await engine.savePgn(pgn)) toast('PGN exported.')
    } else {
      const link = document.createElement('a')
      link.download = 'ShackFish-game.pgn'
      link.href = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }))
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    }
  } catch (error) { toast(error.message) }
}
$('first').onclick = () => goTo(0)
$('prev').onclick = () => goTo(ply - 1)
$('next').onclick = () => goTo(ply + 1)
$('last').onclick = () => goTo(line.moves.length)
$('settings').onclick = settingsDialog
onReactionDismiss(() => {
  dismissedReaction = { game, ply }
  hideReaction()
})
$('live').onclick = () => {
  live = !live
  stopReview()
  persist()
  queueAnalysis()
}
$('review').onclick = () => {
  if (review) {
    stopReview()
    queueAnalysis()
  } else startReview()
}
$('quick-review').onclick = () => startReview(true)
$('prev-critical').onclick = () => {
  const previous = criticalMoves().findLast(move => move.index + 1 < ply)
  if (previous) goTo(previous.index + 1, [])
}
$('next-critical').onclick = () => {
  const next = criticalMoves().find(move => move.index + 1 > ply)
  if (next) goTo(next.index + 1, [])
}
$('worst-move').onclick = () => {
  const worst = criticalMoves().sort((a, b) => b.loss - a.loss)[0]
  if (worst) goTo(worst.index + 1, [])
}
$('retry-mistakes').onclick = startPractice
$('retry-reveal').onclick = () => revealRetry()
$('retry-next').onclick = () => { practice.step++; showRetry() }
$('retry-exit').onclick = () => endPractice()
$('decision-journal').onclick = journalDialog
$('interface-settings').onclick = interfaceDialog
$('board-tab').onclick = () => switchPage('board')
$('scout-tab').onclick = () => switchPage('scout')
$('engines-tab').onclick = () => switchPage('engines')
document.addEventListener('keydown', event => {
  if ($('prompt').open || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return
  if (event.ctrlKey && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    importDialog()
  } else if (event.ctrlKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    startNewBoard()
  } else if (!practice && page === 'board' && event.key === 'ArrowLeft' && ply > 0) goTo(ply - 1)
  else if (!practice && page === 'board' && event.key === 'ArrowRight' && ply < line.moves.length) goTo(ply + 1)
})

createIcons({ icons, attrs: { 'stroke-width': 1.8, 'aria-hidden': 'true' } })
engine?.onEngine(receive)
restore()
applyColors()
applyInterfaceSize()
buildBoard()
goTo(ply)
setupScouting($('scout-page'), engine, (item, index) => {
  showGame(item, index)
  if (engine && !gameReview()?.length && game.moves.length) startReview(true)
}, () => library)
setupAutopsy($('engines-page'), engine, () => ({
  current: { fen: game.start, moves: line.moves.slice(0, ply), title: game.title },
  main: { fen: game.start, moves: game.moves, title: game.title },
}))
