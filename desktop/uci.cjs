const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { dirname } = require('node:path')
const { Chess } = require('chess.js')

function parseInfo(line) {
  if (!line.startsWith('info ')) return null
  const depth = /\bdepth (\d+)/.exec(line)?.[1]
  const rank = /\bmultipv (\d+)/.exec(line)?.[1] ?? 1
  const evaluation = /\bscore (cp|mate) (-?\d+)(?: (lowerbound|upperbound))?/.exec(line)
  const pv = /\bpv (.+)$/.exec(line)?.[1]
  if (!depth || !evaluation || evaluation[3] || !pv) return null
  const [, kind, score] = evaluation
  return {
    depth: Number(depth), rank: Number(rank), kind, score: Number(score),
    nodes: Number(/\bnodes (\d+)/.exec(line)?.[1] ?? 0),
    nps: Number(/\bnps (\d+)/.exec(line)?.[1] ?? 0),
    pv: pv.trim().split(/\s+/),
  }
}

const movePattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/

function validateRequest({ id, fen, moves, depth, lines, threads, hash, review, budget }) {
  if (!Number.isSafeInteger(id) || id < 0 || typeof fen !== 'string' || fen.length > 140 ||
      /[\r\n]/.test(fen) || !Array.isArray(moves) || moves.length > 4000 ||
      !moves.every(move => typeof move === 'string' && movePattern.test(move))) {
    throw new Error('Invalid analysis position.')
  }
  const chess = new Chess(fen)
  for (const move of moves) {
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
  }
  const integer = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback
  return {
    id, fen: new Chess(fen).fen(), moves,
    depth: integer(depth, 6, 30, 16),
    lines: integer(lines, 1, 5, 3),
    threads: integer(threads, 1, 16, 2),
    hash: integer(hash, 16, 512, 64),
    review: review === true,
    budget: integer(budget, 40, 12000, review ? 1500 : 12000),
  }
}

class Stockfish {
  constructor(executable, report) {
    this.executable = executable
    this.report = report
    this.options = {}
  }

  analyze(request) {
    const job = validateRequest(request)
    this.pending = job
    if (!this.child) this.start()
    if (this.active) this.stopActive()
    this.advance()
  }

  start() {
    this.ready = false
    this.options = {}
    this.name = 'Stockfish'
    const child = spawn(this.executable, [], { cwd: dirname(this.executable), windowsHide: true })
    this.child = child
    this.bootTimer = setTimeout(() => this.fail(child, 'Engine did not respond to initialization.'), 20000)
    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', line => {
      if (this.child === child) this.read(line.trim())
    })
    child.on('error', error => this.fail(child, error.message))
    child.stdin.on('error', error => this.fail(child, error.message))
    child.stderr.resume()
    child.on('exit', code => this.fail(child, `Engine exited (${code}).`))
    this.send('uci')
  }

  send(command) { this.child?.stdin.write(command + '\n') }

  read(line) {
    if (line.startsWith('id name ')) this.name = line.slice(8)
    if (line === 'uciok') this.send('isready')
    if (line === 'readyok') {
      clearTimeout(this.bootTimer)
      this.ready = true
      this.advance()
    }
    if (line.startsWith('info string CRITICAL ERROR:')) {
      this.fail(this.child, 'Stockfish rejected the current position.')
      return
    }
    const job = this.active
    if (!job) return
    if (line.startsWith('bestmove ')) {
      clearTimeout(this.stopTimer)
      clearTimeout(this.searchTimer)
      this.active = null
      if (!job.stopping) this.report({ id: job.id, type: 'done', name: this.name, best: line.split(/\s+/)[1] })
      this.advance()
    } else if (!job.stopping) {
      const info = parseInfo(line)
      if (info) this.report({ id: job.id, type: 'info', name: this.name, info })
    }
  }

  advance() {
    if (!this.ready || this.active || !this.pending) return
    const job = this.pending
    this.pending = null
    this.active = job
    for (const [name, value] of Object.entries({ Threads: job.threads, Hash: job.hash, MultiPV: job.lines })) {
      if (this.options[name] !== value) this.send(`setoption name ${name} value ${value}`)
      this.options[name] = value
    }
    this.send(`position fen ${job.fen}${job.moves.length ? ' moves ' + job.moves.join(' ') : ''}`)
    this.send(`go depth ${job.depth} movetime ${job.budget}`)
    this.searchTimer = setTimeout(() => this.fail(this.child, 'Stockfish timed out while analyzing.'), 25000)
  }

  stopActive() {
    if (!this.active || this.active.stopping) return
    this.active.stopping = true
    this.send('stop')
    this.stopTimer = setTimeout(() => {
      const pending = this.pending
      this.dispose()
      this.pending = pending
      if (pending) this.start()
    }, 2500)
  }

  cancel() {
    this.pending = null
    this.stopActive()
  }

  fail(child, message) {
    if (this.child !== child || !child) return
    const job = this.pending ?? this.active
    this.dispose()
    if (job) this.report({ id: job.id, type: 'error', message })
  }

  dispose() {
    clearTimeout(this.bootTimer)
    clearTimeout(this.stopTimer)
    clearTimeout(this.searchTimer)
    const child = this.child
    this.child = null
    this.ready = false
    this.active = null
    this.pending = null
    child?.kill()
  }
}

module.exports = { Stockfish, parseInfo, validateRequest }
