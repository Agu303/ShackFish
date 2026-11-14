import { Chess, DEFAULT_POSITION } from 'chess.js'
import { extendTree, followLine, readTree, writeTree } from './game-tree.mjs'

export const uci = ({ from, to, promotion }) => from + to + (promotion || '')
export function playUci(chess, move) {
  return chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
}

export function newGame(pgn = '', title = 'Analysis board') {
  const chess = new Chess()
  if (pgn) chess.loadPgn(pgn)
  const headers = chess.getHeaders()
  if (headers.Variant && !/^(?:standard|chess|normal)$/i.test(headers.Variant)) {
    throw new Error(`Unsupported variant: ${headers.Variant}.`)
  }
  const history = chess.history({ verbose: true })
  const start = history[0]?.before ?? chess.fen()
  const tree = readTree(pgn, start)
  return {
    id: crypto.randomUUID(), title, pgn, headers, moves: followLine(tree).moves, start, tree,
  }
}

export function loadGames(pgn) {
  const source = pgn.replace(/^\uFEFF/, '').trim()
  if (!source) throw new Error('Paste PGN moves or open a PGN file.')
  if (source.length > 4_000_000) throw new Error('Choose a PGN smaller than 4 MB.')
  const chunks = []
  const tokens = /\{[^}]*\}|[;%][^\r\n]*|\[[^"\]\r\n]*(?:"(?:\\.|[^"\\])*"[^\]\r\n]*)?\]|[()]|[^\s(){}\[;%]+/g
  let start = 0
  let variation = 0
  let moves = false
  for (const item of source.matchAll(tokens)) {
    const token = item[0]
    if (token === '(') variation++
    else if (token === ')') variation = Math.max(0, variation - 1)
    else if (variation || /^[{;%]/.test(token)) continue
    else if (token.startsWith('[')) {
      if (moves) {
        chunks.push(source.slice(start, item.index).trim())
        start = item.index
        moves = false
      }
    } else if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) {
      const end = item.index + token.length
      chunks.push(source.slice(start, end).trim())
      start = end
      moves = false
    } else moves = true
  }
  if (source.slice(start).trim() && !/^(?:\s|\{[^}]*\}|[;%][^\r\n]*)+$/.test(source.slice(start))) {
    chunks.push(source.slice(start).trim())
  }
  if (!chunks.length) throw new Error('No games found in this PGN.')
  return chunks.map((chunk, index) => {
    try {
      const game = newGame(chunk)
      if (!game.moves.length && !game.headers.FEN) throw new Error('This game has no moves or starting position.')
      const players = [game.headers.White, game.headers.Black]
      game.title = players.some(name => name && name !== '?')
        ? players.map(name => name || '?').join(' vs ')
        : game.headers.Event && game.headers.Event !== '?' ? game.headers.Event : `Imported game ${index + 1}`
      return game
    } catch (error) {
      throw new Error(`Game ${index + 1}: ${error.message}`)
    }
  })
}

export function atPosition(game, ply) {
  const chess = new Chess(game.start)
  for (const move of game.moves.slice(0, ply)) chess.move(move)
  return chess
}

export function continueGame(game, path, chess) {
  const { root, path: chosen, fork } = extendTree(game.tree, path, chess.history({ verbose: true }))
  const moves = followLine(root).moves
  const headers = { ...game.headers }
  if (moves.length !== game.moves.length) headers.Result = '*'
  return {
    path: chosen, fork,
    game: root === game.tree ? game : {
      ...game, headers, moves, tree: root, pgn: writeTree(root, headers),
      reviewResults: moves.length === game.moves.length ? game.reviewResults : undefined,
    },
  }
}

export function loadPosition(fen) {
  const chess = new Chess(fen.trim())
  const oldTurn = chess.turn()
  const mirrored = chess.fen().split(' ')
  mirrored[1] = oldTurn === 'w' ? 'b' : 'w'
  mirrored[3] = '-'
  if (new Chess(mirrored.join(' ')).isCheck()) throw new Error('The side that just moved is in check.')
  const game = newGame(chess.fen() === DEFAULT_POSITION ? '' : chess.pgn(), 'Custom position')
  return game
}

export function terminalScore(chess) {
  if (chess.isCheckmate()) return { kind: 'mate', score: 0, blackWins: chess.turn() === 'w' }
  return chess.isDraw() ? { kind: 'cp', score: 0 } : null
}

export function whiteScore(info, turn) {
  return { ...info, score: turn === 'w' ? info.score : -info.score }
}

export function scoreText(score) {
  if (!score) return '—'
  if (score.kind === 'mate') {
    if (!score.score) return score.blackWins ? '−M0' : '+M0'
    return `${score.score > 0 ? '+' : '−'}M${Math.abs(score.score)}`
  }
  return `${score.score > 0 ? '+' : score.score < 0 ? '−' : ''}${(Math.abs(score.score) / 100).toFixed(2)}`
}

export function scoreValue(score) {
  if (score.kind === 'mate') return (score.score < 0 || score.blackWins ? -1 : 1) * (1800 - Math.min(500, Math.abs(score.score)))
  return score.score
}

export function moveLabel(move) {
  const number = move.before.split(' ')[5]
  return `${number}${move.color === 'w' ? '.' : '…'} ${move.san}`
}
