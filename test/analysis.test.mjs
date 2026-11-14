import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { atPosition, continueGame, loadGames, loadPosition, playUci, scoreText, terminalScore, uci, whiteScore } from '../src/chess-state.mjs'
import { followLine } from '../src/game-tree.mjs'
import { classifications, summarizeReview } from '../src/game-review.mjs'
import { captureSquare, engineLine, explainMove, reactionLine } from '../src/shackfish-coach.mjs'
import adapter from '../desktop/uci.cjs'

const { parseInfo, Stockfish, validateRequest } = adapter

test('imports multiple games and branches without losing the original', () => {
  const [game, second] = loadGames(`[Event "Friendly"]
[White "Dana"]
[Black "Robin"]

1. e4 {A comment with 1-0} (1. d4 d5) e5 2. Nf3 Nc6 *

[Event "A second game"]

1. c4 e5 *`)
  assert.equal(game.title, 'Dana vs Robin')
  assert.equal(second.title, 'A second game')
  assert.deepEqual(game.moves.map(uci), ['e2e4', 'e7e5', 'g1f3', 'b8c6'])
  const position = atPosition(game, 1)
  playUci(position, 'c7c5')
  const { game: branch, path } = continueGame(game, [0], position)
  assert.equal(branch.id, game.id)
  assert.deepEqual(path, [0, 1])
  assert.equal(continueGame(game, [0], position).fork, 1)
  assert.equal(game.moves.length, 4)
  const [restored] = loadGames(branch.pgn)
  assert.deepEqual(restored.moves.map(move => move.san), ['e4', 'e5', 'Nf3', 'Nc6'])
  assert.deepEqual(followLine(restored.tree, path).moves.map(move => move.san), ['e4', 'c5'])
  assert.match(restored.pgn, /\{A comment with 1-0\}/)
})

test('board commentary recommends only verified PV moves and handles checkmate', () => {
  const [game] = loadGames('1. f3 e5 2. g4 Qh4# 0-1')
  const before = { kind: 'cp', score: -40, pv: ['g1h3', 'g8f6', 'not-a-move', 'a2a3'] }
  const after = { kind: 'mate', score: -1, pv: ['d8h4'] }
  const moment = explainMove(game.moves[2], before, after, 'Blunder')
  assert.equal(moment.best.san, 'Nh3')
  assert.equal(moment.secondary.san, 'Qh4#')
  assert.match(moment.lesson, /Qh4#/)
  assert.equal(engineLine(game.moves[2].before, before.pv).length, 2)
  assert.deepEqual(engineLine(game.start, ['e7e5']), [])
  assert.equal(explainMove(game.moves[2], {}, after, 'Blunder'), null)
  assert.equal(explainMove(game.moves[3], after, { kind: 'mate', score: 0 }, 'Best').label, 'Checkmate')
  const [ep] = loadGames('1. e4 a6 2. e5 d5 3. exd6 *')
  assert.equal(captureSquare(ep.moves.at(-1)), 'd5')
})

test('all review classes and checkmate have four matching sprites and quips', () => {
  const filenames = readdirSync(new URL('../src/assets/ShackFish%20Reactions/sprites/', import.meta.url))
  const labels = [...Object.keys(classifications), 'Checkmate']
  assert.equal(filenames.length, labels.length * 4)
  for (const label of labels) {
    const lines = []
    for (let index = 0; index < 4; index++) {
      assert.ok(filenames.includes(`shackfish_${label.toLowerCase()}_0${index + 1}.png`))
      const quip = reactionLine(label, index, 1)
      assert.doesNotMatch(quip, /damn|shit|fuck|\{/i)
      lines.push(quip)
    }
    assert.equal(new Set(lines).size, 4)
  }
  assert.match(reactionLine('Blunder', 0, 5), /goddamn/)
})

test('round-trips nested PGN variations and rejoins an existing move', () => {
  const [game] = loadGames('1. e4! $1 {Main} e5 (1... c5 2. Nf3 (2. Nc3 Nc6) d6) 2. Nf3 Nc6 1-0')
  const position = atPosition(game, 1)
  playUci(position, 'c7c5')
  const revisit = continueGame(game, [0], position)
  assert.equal(revisit.game, game)
  assert.deepEqual(revisit.path, [0, 1])
  playUci(position, 'c2c3')
  const edit = continueGame(game, [0, 1], position)
  assert.match(edit.game.pgn, /e4! \$1 \{Main\}/)
  assert.match(edit.game.pgn, /1-0$/)
  const restored = loadGames(edit.game.pgn)[0]
  assert.deepEqual(followLine(restored.tree, [0, 1, 1]).moves.map(move => move.san), ['e4', 'c5', 'Nc3', 'Nc6'])
  assert.deepEqual(followLine(restored.tree, edit.path).moves.map(move => move.san), ['e4', 'c5', 'c3'])
})

test('post-game report distinguishes book, forced, blunder and sacrifice heuristics', () => {
  const [game] = loadGames('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. Nc3 Nf6 6. O-O O-O 7. a3 a6 *')
  const book = { [game.start.split(' ').slice(0, 4).join(' ')]: ['e4'] }
  const results = Array.from({ length: game.moves.length + 1 }, (_, i) => ({
    kind: 'cp', score: i === 3 ? -460 : 0, forced: i === 3,
  }))
  const report = summarizeReview(game, results, book)
  assert.deepEqual(report.moves.slice(0, 4).map(move => move.label), ['Book', 'Excellent', 'Blunder', 'Forced'])
  assert.ok(report.players.w.accuracy < report.players.b.accuracy)
  assert.equal(report.players.w.rating % 50, 0)
  assert.equal(report.players.b.rating % 50, 0)
  assert.equal(summarizeReview(game, results.slice(0, 4), book).players.w.rating, undefined)

  const [tactic] = loadGames('[SetUp "1"]\n[FEN "3rk3/8/8/8/8/8/8/3QK3 w - - 0 1"]\n\n1. Qxd8+ *')
  const scores = [{ kind: 'cp', score: 0, pv: ['d1d8', 'e8d8'] }, { kind: 'cp', score: 0 }]
  assert.equal(summarizeReview(tactic, scores, {}).moves[0].label, 'Brilliant')
})

test('round-trips a custom starting position and preserves promotion', () => {
  const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1'
  const game = loadPosition(fen)
  assert.equal(loadGames(game.pgn)[0].start, fen)
  const board = atPosition(game, 0)
  playUci(board, 'a7a8n')
  assert.equal(board.get('a8').type, 'n')
  assert.equal(terminalScore(board).score, 0)
})

test('keeps repetition history and reports a terminal checkmate from White’s perspective', () => {
  const [repetition] = loadGames('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *')
  assert.ok(atPosition(repetition, repetition.moves.length).isThreefoldRepetition())
  const [mate] = loadGames('1. f3 e5 2. g4 Qh4# 0-1')
  assert.equal(scoreText(terminalScore(atPosition(mate, mate.moves.length))), '−M0')
})

test('parses exact ranked evaluations, skips bounds and rejects command injection', () => {
  const prefix = 'info depth 14 seldepth 20 multipv 2 score cp 41'
  const suffix = 'nodes 11421 nps 8761 hashfull 0 tbhits 0 time 1 pv c7c5 g1f3'
  const info = parseInfo(`${prefix} ${suffix}`)
  assert.deepEqual(info.pv, ['c7c5', 'g1f3'])
  assert.equal(info.rank, 2)
  assert.equal(scoreText(whiteScore(info, 'b')), '−0.41')
  assert.equal(parseInfo(`${prefix} lowerbound ${suffix}`), null)
  assert.throws(() => validateRequest({ id: 3, fen: 'invalid\nquit', moves: [] }), /Invalid analysis position/)
})

const executable = fileURLToPath(new URL('../engine/stockfish.exe', import.meta.url))
test('bundled Stockfish returns lines for the latest requested position', {
  timeout: 20000, skip: process.platform !== 'win32' || !existsSync(executable),
}, async () => {
  const events = []
  let adapter
  try {
    const [game] = loadGames('1. e4 e5 *')
    const done = new Promise((resolve, reject) => {
      adapter = new Stockfish(executable, event => {
        events.push(event)
        if (event.type === 'error') reject(new Error(event.message))
        if (event.id === 2 && event.type === 'done') resolve()
        if (event.id === 1 && event.type === 'info') {
          adapter.analyze({ id: 2, fen: game.start, moves: ['e2e4'], depth: 9, lines: 3 })
        }
      })
    })
    adapter.analyze({ id: 1, fen: game.start, moves: [], depth: 26 })
    await done
    assert.ok(!events.some(event => event.id === 1 && event.type === 'done'))
    assert.ok(events.some(event => event.id === 2 && event.info?.rank === 3))
    assert.equal(events.at(-1).name, 'Stockfish 19')
    for (const event of events.filter(event => event.id === 2 && event.type === 'info')) {
      assert.doesNotThrow(() => playUci(atPosition(game, 1), event.info.pv[0]))
    }
  } finally {
    adapter?.dispose()
  }
})
