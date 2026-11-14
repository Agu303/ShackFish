import { Chess } from 'chess.js'

const annotation = /^(?:\$\d+|[!?]{1,2})$/
const result = /^(?:1-0|0-1|1\/2-1\/2|\*)$/

const node = (move = null) => ({ move, notes: [], children: [] })

export function readTree(pgn, fen) {
  const root = node()
  const chess = new Chess(fen)
  let current = root
  let parent = null
  const stack = []
  const tokens = /\[[^"\]\r\n]*(?:"(?:\\.|[^"\\])*"[^\]\r\n]*)?\]|\{[^}]*\}|[;%][^\r\n]*|[()]|\$\d+|[^\s(){}\[;%$]+/g
  for (const [token] of pgn.matchAll(tokens)) {
    if (/^[\[%]/.test(token)) continue
    if (token === '(') {
      if (!parent) throw new Error('A variation must follow a move.')
      stack.push({ current, parent })
      chess.undo()
      current = parent
      parent = null
    } else if (token === ')') {
      if (!stack.length) throw new Error('Unexpected end of variation.')
      while (parent) {
        chess.undo()
        current = parent
        parent = current.parent
        if (current === stack.at(-1).parent) break
      }
      const resume = stack.pop()
      current = resume.current
      parent = resume.parent
      chess.move(current.move)
    } else if (/^[{;]/.test(token) || annotation.test(token)) {
      const note = token.startsWith(';') ? '{' + token.slice(1).replaceAll('}', '') + '}' : token
      // A leading comment in a variation belongs to its first move.
      if (!parent && stack.length) (stack.at(-1).notes ??= []).push(note)
      else current.notes.push(note)
    } else {
      const san = token.replace(/^\d+\.(?:\.\.)?/, '')
      if (!san || san === '...' || result.test(san)) continue
      const suffix = /[!?]+$/.exec(san)?.[0]
      const child = node(chess.move(san))
      child.parent = current
      if (!parent && stack.at(-1)?.notes) child.notes.push(...stack.at(-1).notes)
      if (suffix) child.notes.push(suffix)
      current.children.push(child)
      parent = current
      current = child
    }
  }
  // The parser uses parent links only while rewinding PGN variations.
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    delete current.parent
    for (const child of current.children) pending.push(child)
  }
  return root
}

export function followLine(root, path = []) {
  const moves = []
  const choices = []
  let current = root
  while (current.children.length) {
    const index = current.children[path[moves.length]] ? path[moves.length] : 0
    current = current.children[index]
    moves.push(current.move)
    choices.push(index)
  }
  return { moves, path: choices }
}

export function extendTree(root, path, moves) {
  const ancestors = []
  let current = root
  let fork
  for (let depth = 0; depth < moves.length; depth++) {
    const move = moves[depth]
    const matching = current.children.findIndex(child =>
      child.move.from === move.from && child.move.to === move.to && child.move.promotion === move.promotion)
    const index = depth < path.length ? path[depth] : matching < 0 ? current.children.length : matching
    if (fork === undefined && index > 0 && !current.children[index]) fork = depth
    ancestors.push({ current, index })
    current = current.children[index] ?? node(move)
  }
  const choices = ancestors.map(({ index }) => index)
  let updated = current
  for (const { current, index } of ancestors.reverse()) {
    if (current.children[index] === updated) {
      updated = current
    } else {
      const children = [...current.children]
      children[index] = updated
      updated = { ...current, children }
    }
  }
  return { root: updated, path: choices, fork }
}

export function writeTree(root, headers) {
  const lines = Object.entries(headers).map(([key, value]) =>
    `[${key} "${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`)
  function branch(parent, first = 0) {
    const parts = []
    let index = first
    while (parent.children.length) {
      const child = parent.children[index]
      const { move } = child
      const number = move.before.split(' ')[5]
      const [suffix, ...notes] = child.notes[0]?.match(/^[!?]{1,2}$/) ? child.notes : ['', ...child.notes]
      parts.push(`${number}${move.color === 'w' ? '.' : '...'} ${move.san}${suffix}`, ...notes)
      if (index === 0) {
        for (let i = 1; i < parent.children.length; i++) parts.push(`(${branch(parent, i)})`)
      }
      parent = child
      index = 0
    }
    return parts.join(' ')
  }
  return [lines.join('\n'), [...root.notes, branch(root), headers.Result || '*'].filter(Boolean).join(' ')].filter(Boolean).join('\n\n')
}
