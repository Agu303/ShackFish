import { Chess } from 'chess.js'
import { playUci, uci } from './chess-state.mjs'

const pieces = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const reactions = {
  Book: ['Yep. It’s in the book.', 'The librarian approves.', 'Found that one in my notes.', 'Opening theory. Riveting stuff.'],
  Brilliant: ['I need a second to process that.', 'Put that sacrifice in the trophy case.', 'Raise the {banner}.', 'That is going straight into the highlight reel.'],
  Great: ['The booth is on its feet.', 'That earned a fin bump.', 'Replay that one in slow motion.', 'Okay, now we’re cooking.'],
  Best: ['Gold star. Keep it away from the water.', 'Right there. That’s the move.', 'Crown the move, chat.', 'Right on the bullseye.'],
  Excellent: ['Quietly taking notes over here.', 'That earns a ribbon.', 'Pretty smooth, honestly.', 'Polite golf clap from the shack.'],
  Good: ['Solid work on the board.', 'That’ll do, fish.', 'Good enough for a coffee break.', 'Small flag of approval.'],
  Inaccuracy: ['I’m giving that one the side-eye.', 'A little {shaky}, chat.', 'Can I get a replay on that?', 'Tiny wobble. Keep going.'],
  Mistake: ['The booth has concerns.', 'My fin just hit my forehead.', 'Timeout. Let’s look again.', 'I’m adding this to the incident report.'],
  Miss: ['The opportunity was right there.', 'The move let the opportunity slip.', 'Gift returned to sender.', 'Hey, the target was over here.'],
  Blunder: ['The position just fell through the {floor}.', 'Chat, clip that. The position is in pieces.', '{wow} Somebody hit the alarm.', 'That move needs a fire extinguisher.'],
  Forced: ['One lane. No traffic.', 'The sign says only way out.', 'Follow the arrow.', 'Well, that settles the question.'],
  Checkmate: ['Shades on. Game over.', 'Crown the finish.', 'Take a bow. That’s mate.', 'The king is officially out of office.'],
}

const vocabulary = [
  { shaky: 'sketchy', floor: 'floor', wow: 'Good grief.', banner: 'banner' },
  { shaky: 'sus', floor: 'floorboards', wow: 'Damn.', banner: 'banner' },
  { shaky: 'sus as hell', floor: 'damn floor', wow: 'What the hell.', banner: 'damn banner' },
  { shaky: 'shaky as shit', floor: 'whole damn floor', wow: 'Shit.', banner: 'whole damn banner' },
  { shaky: 'sus as fuck', floor: 'goddamn floor', wow: 'Fuck me sideways.', banner: 'fucking banner' },
]

export function reactionLine(label, variant, level) {
  const words = vocabulary[level - 1] ?? vocabulary[0]
  return reactions[label][variant].replace(/\{(\w+)\}/g, (_, key) => words[key])
}

// Decode only the continuation supplied by Stockfish, stopping at the first invalid move.
export function engineLine(fen, pv = []) {
  const position = new Chess(fen)
  const moves = []
  for (const move of pv.slice(0, 6)) {
    try {
      moves.push(playUci(position, move))
    } catch {
      break
    }
  }
  return moves
}

export function captureSquare(move) {
  return move.captured && (move.isEnPassant() ? move.to[0] + move.from[1] : move.to)
}

export function explainMove(move, before, after, classification) {
  const moves = engineLine(move.before, before.pv)
  const best = moves[0]
  if (!best) return null

  const label = move.san.endsWith('#') ? 'Checkmate' : classification
  const compact = label === 'Book' || label === 'Forced'
  const sameMove = uci(best) === uci(move)
  const reply = sameMove ? moves[1] : engineLine(move.after, after.pv)[0]
  let lesson
  let secondary

  if (label === 'Checkmate') {
    lesson = `${move.san} ended the game with checkmate.`
  } else if (label === 'Book') {
    lesson = 'The played move appears in the opening book.'
  } else if (label === 'Forced') {
    lesson = 'There was only one legal move.'
  } else if (label === 'Brilliant' && sameMove && reply?.to === move.to && reply.captured) {
    lesson = `Stockfish still likes the move after ${reply.san} takes the ${pieces[reply.captured]}.`
    secondary = reply
  } else if (best.san.endsWith('#')) {
    lesson = `${best.san} delivers immediate checkmate.`
  } else if (!sameMove && reply?.captured) {
    lesson = `After ${move.san}, Stockfish replies ${reply.san} and takes the ${pieces[reply.captured]}.`
    secondary = reply
  } else if (!sameMove && reply?.san.endsWith('#')) {
    lesson = `After ${move.san}, Stockfish finds immediate mate with ${reply.san}.`
    secondary = reply
  } else if (best.promotion) {
    lesson = `The engine’s move immediately promotes to a ${pieces[best.promotion]}.`
  } else if (best.captured) {
    lesson = `Stockfish’s line starts by taking a ${pieces[best.captured]}${best.san.endsWith('+') ? ' with check' : ''}.`
  } else if (best.san.endsWith('+')) {
    lesson = 'The engine’s move gives check and forces a response to the king threat.'
  } else if (best.san.startsWith('O-O')) {
    lesson = 'Castling takes the king away from the center and brings a rook into play.'
  } else {
    const followUp = moves.slice(2).find(next => next.color === best.color && (next.captured || next.san.endsWith('#')))
    if (followUp) {
      lesson = `In Stockfish’s line, ${followUp.san} ${followUp.san.endsWith('#') ? 'delivers mate' : `takes a ${pieces[followUp.captured]}`}.`
      secondary = followUp
    } else {
      lesson = 'Compare the opponent’s checks, captures, and threats after both moves before committing.'
    }
  }
  const checkedKing = label === 'Checkmate'
    ? new Chess(move.after).board().flat().find(piece => piece?.type === 'k' && piece.color !== move.color)?.square
    : undefined
  return { label, compact, move, best, secondary, lesson, checkedKing }
}
