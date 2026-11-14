import { captureSquare, reactionLine } from './shackfish-coach.mjs'

const art = import.meta.glob('./assets/ShackFish Reactions/sprites/*.png', { eager: true, query: '?url', import: 'default' })
const sprites = Object.fromEntries(Object.entries(art).map(([path, url]) => [path.split('/').at(-1), url]))
const svgNS = 'http://www.w3.org/2000/svg'
const colors = {
  Book: '#c5afe9', Brilliant: '#63e4db', Great: '#82d8ff', Best: '#92e794',
  Excellent: '#a7e78a', Good: '#bed991', Inaccuracy: '#ffd369', Mistake: '#ff9c53',
  Miss: '#ff7095', Blunder: '#ff515e', Forced: '#b8a8e2', Checkmate: '#f4ba57',
}
const element = id => document.getElementById(id)
const board = element('board')
const overlay = element('review-overlay')
const panel = element('board-reaction')
const space = element('reaction-space')
const tail = element('reaction-tail')
const sprite = element('reaction-sprite')
const bubble = element('reaction-bubble')
let current
let last
let frame
let fade

export function squarePoint(square, flipped) {
  const x = square.charCodeAt(0) - 97
  const y = 8 - Number(square[1])
  return { x: (flipped ? 7 - x : x) * 100 + 50, y: (flipped ? 7 - y : y) * 100 + 50 }
}

function svg(tag, attributes) {
  const node = document.createElementNS(svgNS, tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

function outline(square, color, flipped, emphasis = false) {
  const { x, y } = squarePoint(square, flipped)
  for (const [stroke, width] of [['#111422', 13], [color, emphasis ? 8 : 5]]) {
    overlay.append(svg('rect', {
      x: x - 47, y: y - 47, width: 94, height: 94, rx: 4, fill: 'none',
      stroke, 'stroke-width': width, 'data-square': square,
    }))
  }
}

function arrow(move, color, flipped, role) {
  const from = squarePoint(move.from, flipped)
  const to = squarePoint(move.to, flipped)
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (!distance) return
  const dx = (to.x - from.x) / distance
  const dy = (to.y - from.y) / distance
  const x = to.x - dx * 15
  const y = to.y - dy * 15
  const neck = { x: x - dx * 27, y: y - dy * 27 }
  overlay.append(svg('path', {
    d: `M ${from.x + dx * 20} ${from.y + dy * 20} L ${neck.x} ${neck.y}`,
    stroke: '#111422', 'stroke-width': 18, 'stroke-linecap': 'round', fill: 'none',
  }), svg('path', {
    d: `M ${from.x + dx * 20} ${from.y + dy * 20} L ${neck.x} ${neck.y}`,
    stroke: color, 'stroke-width': 11, 'stroke-linecap': 'round', fill: 'none',
    'data-arrow': role, 'data-from': move.from, 'data-to': move.to,
  }), svg('polygon', {
    points: `${x},${y} ${neck.x - dy * 16},${neck.y + dx * 16} ${neck.x + dy * 16},${neck.y - dx * 16}`,
    fill: color, stroke: '#111422', 'stroke-width': 4, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
  }))
}

const clamp = (value, low, high) => Math.max(low, Math.min(value, high))

function place() {
  if (!current || panel.hidden) return
  const { info, flipped } = current
  const rect = board.getBoundingClientRect()
  const focus = squarePoint(info.checkedKing || (info.secondary && captureSquare(info.secondary)) || info.move.to, flipped)
  const x = rect.left + rect.width * focus.x / 800
  const y = rect.top + rect.height * focus.y / 800
  // The art fills most of each PNG. Leave extra room for transparent padding.
  panel.style.setProperty('--sprite-size', `${Math.ceil(rect.width * 1.72 / 8)}px`)
  const side = getComputedStyle(panel).position === 'absolute'
  const region = space.getBoundingClientRect()
  if (side) {
    const headOffset = sprite.offsetTop + sprite.offsetHeight * .14
    panel.style.setProperty('--reaction-top', `${clamp(y - region.top - headOffset, 0, Math.max(0, region.height - panel.offsetHeight))}px`)
  } else {
    const max = region.width - panel.offsetWidth
    panel.style.setProperty('--reaction-left', `${clamp(x - region.left - sprite.offsetWidth / 2, 0, Math.max(0, max))}px`)
  }

  // Sprites use the same pose and framing, with the head in the upper-right part of the art.
  const head = {
    x: sprite.offsetLeft + sprite.offsetWidth * .64,
    y: sprite.offsetTop + sprite.offsetHeight * .13,
  }
  const edge = side
    ? { x: clamp(head.x, bubble.offsetLeft + 18, bubble.offsetLeft + bubble.offsetWidth - 18), y: bubble.offsetTop + bubble.offsetHeight }
    : { x: bubble.offsetLeft, y: bubble.offsetTop + 15 }
  tail.replaceChildren(...[.23, .49, .75].map((ratio, index) => svg('circle', {
    cx: edge.x + (head.x - edge.x) * ratio,
    cy: edge.y + (head.y - edge.y) * ratio,
    r: 4.5 - 1.15 * index,
  })))
}

function queuePlacement() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(place)
}

export function hideReaction() {
  overlay.replaceChildren()
  current = undefined
  panel.inert = true
  if (panel.hidden || panel.classList.contains('dismissed')) return
  panel.classList.add('dismissed')
  fade = setTimeout(() => { panel.hidden = true }, 150)
}

export function showReaction(info, flipped, level) {
  clearTimeout(fade)
  if (!current || current.info !== info || current.level !== level) {
    const choices = Array.from({ length: 4 }, (_, index) => index).filter(index =>
      last?.label !== info.label || last.index !== index)
    const index = choices[Math.floor(Math.random() * choices.length)]
    last = { label: info.label, index }
    const filename = `shackfish_${info.label.toLowerCase()}_0${index + 1}.png`
    sprite.querySelector('img').src = sprites[filename]
    element('reaction-title').textContent = `${info.label} · Best move ${info.best.san}`
    element('reaction-lesson').textContent = info.lesson
    element('reaction-quip').textContent = reactionLine(info.label, index, level)
  }
  current = { info, flipped, level }
  overlay.replaceChildren()
  for (const square of [info.move.from, info.move.to]) outline(square, colors[info.label], flipped, square === info.move.to)
  for (const square of new Set([info.checkedKing, captureSquare(info.best), info.secondary && captureSquare(info.secondary)])) {
    if (square && square !== info.move.to && square !== info.move.from) outline(square, '#ff515e', flipped, true)
  }
  arrow(info.best, '#54f5bd', flipped, 'best')
  if (info.secondary) arrow(info.secondary, '#e4a0ff', flipped, 'secondary')
  panel.classList.toggle('compact-reaction', info.compact)
  panel.classList.remove('dismissed')
  panel.inert = false
  panel.hidden = false
  place()
}

export function onReactionDismiss(callback) {
  sprite.onclick = callback
  bubble.onclick = callback
}

export function reserveReactionSpace(ready) {
  space.parentElement.classList.toggle('reactions-ready', ready)
}

const layoutObserver = new ResizeObserver(queuePlacement)
layoutObserver.observe(board)
layoutObserver.observe(space)
window.addEventListener('resize', queuePlacement)
