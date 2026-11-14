import { Chess, DEFAULT_POSITION } from 'chess.js'
import { playUci, uci } from './chess-state.mjs'

export const classifications = {
  Book: '▤', Brilliant: '!!', Great: '!', Best: '★', Excellent: '✓', Good: '·',
  Inaccuracy: '?!', Mistake: '?', Miss: '×', Blunder: '??', Forced: '↳',
}

function winPercent({ kind, score, blackWins }, color) {
  const white = kind === 'mate'
    ? (score < 0 || blackWins ? 0 : 100)
    : 100 / (1 + Math.exp(-0.00368208 * score))
  return color === 'w' ? white : 100 - white
}

function sacrifice(move, before) {
  const [played, reply, recapture] = before.pv ?? []
  if (played !== uci(move) || !reply || reply.slice(2, 4) !== move.to) return false
  const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  const start = values[move.promotion ?? move.piece]
  if (start < 3 || move.promotion) return false
  try {
    const position = new Chess(move.after)
    const take = playUci(position, reply)
    if (!take.captured) return false
    const returned = recapture ? values[playUci(position, recapture).captured] ?? 0 : 0
    return start - (values[move.captured] ?? 0) - returned >= 2
  } catch {
    return false
  }
}

export function summarizeReview(game, results, openingBook) {
  const players = { w: { moves: [], counts: {} }, b: { moves: [], counts: {} } }
  let inBook = game.start === DEFAULT_POSITION
  const moves = game.moves.slice(0, Math.max(0, (results?.length ?? 0) - 1)).map((move, index) => {
    const before = results[index]
    const after = results[index + 1]
    const expected = winPercent(before, move.color)
    const actual = winPercent(after, move.color)
    const best = before.pv?.[0] === uci(move)
    const loss = best ? 0 : Math.max(0, expected - actual)
    const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669))
    inBook &&= loss < 14 && openingBook[move.before.split(' ').slice(0, 4).join(' ')]?.includes(move.san) === true
    const forced = before.forced === true
    const previously = index > 0 ? winPercent(results[index - 1], move.color) : expected
    let label
    if (inBook) label = 'Book'
    else if (forced) label = 'Forced'
    else if (best && actual >= 46 && (expected <= 88 || after.kind === 'mate') && sacrifice(move, before)) label = 'Brilliant'
    else if (best && expected - previously >= 15 && actual >= 48) label = 'Great'
    else if (best) label = 'Best'
    else if (loss >= 25) label = 'Blunder'
    else if (loss >= 12 && expected >= 62 && expected - previously >= 15) label = 'Miss'
    else if (loss >= 14) label = 'Mistake'
    else if (loss >= 7) label = 'Inaccuracy'
    else if (loss >= 2.5) label = 'Good'
    else label = 'Excellent'
    const player = players[move.color]
    player.counts[label] = (player.counts[label] ?? 0) + 1
    if (!inBook && !forced) player.moves.push(accuracy)
    return { label, loss, accuracy, best }
  })

  for (const [color, player] of Object.entries(players)) {
    const count = player.moves.length
    if (count) player.accuracy = player.moves.reduce((sum, value) => sum + value, 0) / count
    if (count >= 5) {
      const quality = 500 + 2250 * (player.accuracy / 100) ** 2
      const tag = game.headers[color === 'w' ? 'WhiteElo' : 'BlackElo']
      const known = Number(tag)
      const rating = /^\d{3,4}$/.test(tag ?? '') && known >= 100 && known <= 3500
        ? known * 0.55 + quality * 0.45
        : quality
      player.rating = Math.round(rating / 50) * 50
    }
  }
  return { moves, players }
}
