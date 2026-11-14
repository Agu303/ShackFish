import { Chess } from 'chess.js'
import { playUci, scoreText, uci, whiteScore } from './chess-state.mjs'
import { engineLine } from './shackfish-coach.mjs'

function describe(result, fen) {
  if (result.type === 'error') return { text: result.message, trouble: true }
  const chess = new Chess(fen)
  let best
  try { best = playUci(chess, result.best).san }
  catch { return { text: `Invalid bestmove: ${result.best || '(missing)'}`, trouble: true } }
  if (!result.info) return { best, text: `${best} · No scored line` }
  const score = scoreText(whiteScore(result.info, new Chess(fen).turn()))
  const line = engineLine(fen, result.info.pv).map(move => move.san).join(' ')
  return {
    best, score,
    text: `${best} · ${score} White · depth ${result.info.depth} · ${result.info.nodes.toLocaleString()} nodes · ${result.elapsed} ms including startup${line ? ` · PV ${line}` : ''}`,
  }
}

export function setupAutopsy(root, engine, board) {
  root.innerHTML = `<div class="panel tool-hero"><img src="./logo.png" alt=""><div><h2>Engine Autopsy</h2>
  <p>Give two UCI builds the same positions and search budget. See where they choose different moves, stall, or fail to return a legal answer.</p></div></div>
  <section class="panel tool-card">
  <div class="tool-fields"><div><label>Baseline engine</label><button class="button" id="autopsy-a">Choose baseline EXE</button>
    <button class="button" id="autopsy-reset">Use bundled Stockfish</button><p class="muted" id="autopsy-a-name">Bundled Stockfish</p></div>
  <div><label>Candidate engine</label><button class="button" id="autopsy-b">Choose candidate EXE</button><p class="muted" id="autopsy-b-name">No engine selected</p></div></div>
  <p class="muted">Choose executables you trust. Keep each engine with its DLLs and network files. Each search requests one thread and 64 MB hash where supported.</p>
  <div class="tool-fields"><label>Positions<select id="autopsy-source"><option value="current">Current board position</option>
    <option value="main">Sample up to 12 positions across the game</option><option value="custom">Custom FEN</option></select></label>
    <label>Time cap per position<select id="autopsy-time"><option value="250">250 ms</option><option value="1000" selected>1 second</option><option value="3000">3 seconds</option><option value="10000">10 seconds</option></select></label>
    <label>Maximum depth<select id="autopsy-depth"><option>12</option><option selected>20</option><option>30</option></select></label>
  </div>
  <label id="autopsy-fen-label" hidden>FEN <input id="autopsy-fen" maxlength="140" placeholder="Paste a standard chess FEN"></label>
  <div class="tool-actions"><button class="button primary" id="autopsy-run">Compare engines</button>
    <button class="button" id="autopsy-stop" disabled>Stop</button><button class="button" id="autopsy-export" disabled>Export Markdown</button></div>
  <p class="muted" id="autopsy-status" role="status"></p></section>
  <section class="panel tool-card"><h2>Position comparisons</h2>
    <p class="muted">Scores are shown from White’s side. Engine scores use different scales, so a disagreement alone doesn’t establish a regression.</p>
    <div class="tool-results" id="autopsy-results"></div>
  </section>`
  const $ = id => root.querySelector('#autopsy-' + id)
  let baseline
  let candidate
  let running = false
  let stopped = false
  let report = ''
  let choosing = false

  function controls() {
    for (const id of ['a', 'b', 'reset', 'source', 'time', 'depth', 'fen']) $(id).disabled = !engine || running || choosing
    $('run').disabled = !engine || !candidate || running || choosing
    $('stop').disabled = !running || stopped
    $('export').disabled = running || !report
  }

  for (const slot of ['a', 'b']) {
    $(slot).onclick = async () => {
      choosing = true
      controls()
      try {
        const info = await engine.selectEngine(slot)
        if (!info) return
        if (slot === 'a') baseline = info
        else candidate = info
        $(slot + '-name').textContent = info.label
        $('status').textContent = ''
      } catch (error) { $('status').textContent = error.message }
      finally { choosing = false; controls() }
    }
  }
  $('reset').onclick = () => {
    baseline = null
    $('a-name').textContent = 'Bundled Stockfish'
    controls()
  }
  $('source').onchange = () => { $('fen-label').hidden = $('source').value !== 'custom' }
  $('stop').onclick = () => { stopped = true; controls(); engine.stopComparison() }
  $('export').onclick = async () => {
    try { if (await engine.exportAutopsy(report)) $('status').textContent = 'Autopsy report exported.' }
    catch (error) { $('status').textContent = error.message }
  }

  $('run').onclick = async () => {
    running = true
    stopped = false
    report = ''
    controls()
    $('results').replaceChildren()
    const nameA = baseline?.label ?? 'Bundled Stockfish'
    const nameB = candidate.label
    const budget = Number($('time').value)
    const depth = Number($('depth').value)
    let differences = 0
    let errors = 0
    let completed = 0
    try {
      const source = $('source').value
      const game = source === 'custom' ? { fen: new Chess($('fen').value.trim()).fen(), moves: [], title: 'Custom position' } :
        board()[source]
      const indexes = source === 'main' && game.moves.length ?
        [...new Set(Array.from({ length: 12 }, (_, i) => Math.round(i * game.moves.length / 11)))] : [game.moves.length]
      const positions = []
      const chess = new Chess(game.fen)
      for (let index = 0; index <= game.moves.length; index++) {
        if (indexes.includes(index) && !chess.isGameOver()) {
          positions.push({ fen: chess.fen(), index, moves: game.moves.slice(0, index).map(uci) })
        }
        if (index < game.moves.length) chess.move(game.moves[index])
      }
      if (!positions.length) throw new Error('Choose a position where the game is still in progress.')
      const details = [
        '# ShackFish Engine Autopsy', '', game.title.replace(/[\r\n]/g, ' '), '',
        `Baseline: ${nameA}${baseline ? ` (SHA-256 ${baseline.sha256})` : ''}`,
        `Candidate: ${nameB} (SHA-256 ${candidate.sha256})`,
        `Windows · ${navigator.hardwareConcurrency} logical CPUs · ${new Date().toISOString()}`,
        `Search: depth ${depth}, ${budget} ms, one line, one thread and 64 MB hash requested.`,
        'Scores shown from White’s perspective. Engine scoring scales can differ.', '',
      ]
      for (const position of positions) {
        if (stopped) break
        $('status').textContent = `Comparing position ${completed + 1} / ${positions.length}…`
        const result = await engine.comparePosition({
          request: { fen: game.fen, moves: position.moves, budget, depth },
          slots: [baseline ? 'a' : 'stockfish', 'b'],
        })
        if (!result || stopped) break
        const first = describe(result.first, position.fen)
        const second = describe(result.second, position.fen)
        const failed = first.trouble || second.trouble
        const differs = !failed && first.best !== second.best
        if (failed) errors++
        if (differs) differences++
        const verdict = failed ? 'Engine issue' : differs ? 'Different moves' : 'Same best move'
        const item = document.createElement('details')
        item.className = 'autopsy-result'
        item.open = failed || differs || positions.length === 1
        const title = document.createElement('summary')
        title.textContent = `After ${position.index} plies · ${verdict}`
        const comparisons = [`${result.first.name ?? nameA}: ${first.text}`, `${result.second.name ?? nameB}: ${second.text}`]
        const reproduction = `position fen ${game.fen}${position.moves.length ? ' moves ' + position.moves.join(' ') : ''}`
        item.append(title, ...[...comparisons, position.fen].map((value, index) => {
          const line = document.createElement(index === 2 ? 'code' : 'p')
          line.textContent = value
          return line
        }))
        $('results').append(item)
        details.push(`## After ${position.index} plies · ${verdict}`, ...comparisons,
          '~~~text', reproduction, `go depth ${depth} movetime ${budget}`, '~~~', '')
        completed++
        report = details.join('\n')
      }
      $('status').textContent = `${stopped ? 'Stopped. ' : ''}${completed} compared · ${differences} different best moves · ${errors} engine issues.`
    } catch (error) { $('status').textContent = error.message }
    finally { running = false; controls() }
  }
  controls()
}
