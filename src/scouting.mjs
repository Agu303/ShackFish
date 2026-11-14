import { newGame, moveLabel, uci } from './chess-state.mjs'
import { summarizeReview } from './game-review.mjs'
import { engineLine } from './shackfish-coach.mjs'
import openingBook from './assets/opening-book.json'

const profileKey = 'shackfish-scout-profile'
const serious = new Set(['Miss', 'Mistake', 'Blunder'])

function tags(pgn) {
  return Object.fromEntries([...pgn.matchAll(/^\[(\w+) "((?:\\.|[^"\\])*)"\]/gm)]
    .map(([, key, value]) => [key, value]))
}

function patterns(game, results, side) {
  const samples = []
  const { moves } = summarizeReview(game, results, openingBook)
  for (const [index, item] of moves.entries()) {
    const move = game.moves[index]
    if (move.color !== side || !serious.has(item.label)) continue
    const reply = engineLine(move.after, results[index + 1].pv)[0]
    const best = engineLine(move.before, results[index].pv)[0]
    let theme = 'Other costly moves'
    let detail = best ? `Stockfish preferred ${best.san}.` : ''
    if (reply?.san.endsWith('#')) {
      theme = 'Allowed immediate mate'
      detail = `Stockfish replies ${reply.san}.`
    } else if (best?.san.endsWith('#')) {
      theme = 'Missed immediate mate'
    } else if (reply?.captured) {
      theme = 'Allowed an immediate capture in the engine line'
      detail = `Stockfish replies ${reply.san}.`
    }
    samples.push({ theme, detail, index, item, game })
  }
  return samples
}

export function setupScouting(root, engine, showGame, savedGames) {
  root.innerHTML = `<div class="panel tool-hero"><img src="./logo.png" alt=""><div><h2>Scout your own games</h2>
  <p>Sync completed public games by username. ShackFish finds recurring mistakes and takes you back to the board to investigate.</p></div></div>
  <form class="panel tool-card" id="scout-form"><div class="tool-fields">
    <label>Game source<select id="scout-site"><option value="chesscom">Chess.com</option><option value="lichess">Lichess</option></select></label>
    <label>Username<input id="scout-user" maxlength="40" pattern="[a-zA-Z0-9_\\-]+" required autocomplete="off"></label>
    <label>Recent games<select id="scout-limit"><option>100</option><option selected>300</option><option>600</option></select></label>
  </div><div class="tool-actions"><button class="button primary" id="scout-sync">Connect and sync</button>
    <button class="button" type="button" id="scout-disconnect">Disconnect</button></div>
    <p class="muted" id="scout-status" role="status"></p></form>
  <section class="panel tool-card"><h2>Account overview</h2><div id="scout-summary" class="tool-metrics"></div><p id="scout-openings" class="muted"></p></section>
  <section class="panel tool-card"><h2>Recurring mistakes</h2><p class="muted">Review the newest games with a shallow Stockfish pass. Open any example to inspect it or run a deeper review.</p>
    <div class="tool-actions"><label>Sample size <select id="scout-sample"><option>5</option><option selected>10</option><option>25</option><option>50</option></select></label>
    <button class="button primary" id="scout-analyze">Analyze sample</button><button class="button" id="scout-stop" disabled>Stop</button></div>
    <p id="scout-progress" class="muted" role="status"></p><div id="scout-patterns" class="tool-results"></div></section>
  <section class="panel tool-card"><h2>Synced games</h2><div class="tool-fields">
    <label>Find opponent or opening<input id="scout-filter" type="search"></label>
    <label>Time control<select id="scout-speed"><option value="">All</option></select></label>
  </div><div id="scout-games" class="tool-results"></div><button class="button" id="scout-more" hidden>Show more</button></section>`
  const $ = id => root.querySelector('#scout-' + id)
  let profile
  let records = []
  let showCount = 30
  let syncing = false
  let running = false
  let cancelled = false
  const reviewed = new Map()

  function gameFor(record) {
    const saved = savedGames().find(game => game.id === record.key)
    if (saved) return saved
    return { ...newGame(record.pgn, record.title), id: record.key, reviewResults: reviewed.get(record.key) }
  }

  function openRecord(record) {
    try { showGame(gameFor(record), 0) }
    catch (error) { $('status').textContent = error.message }
  }

  function button(label, action) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'button tool-result'
    node.textContent = label
    node.onclick = action
    return node
  }

  function renderList() {
    const query = $('filter').value.trim().toLowerCase()
    const speed = $('speed').value
    const found = records.filter(record => (!speed || record.speed === speed) &&
      `${record.title} ${record.opening ?? ''}`.toLowerCase().includes(query))
    $('games').replaceChildren(...found.slice(0, showCount).map(record => button(
      [record.title, record.tags.Result, record.speed, record.date ? new Date(record.date).toLocaleDateString() : ''].filter(Boolean).join(' · '),
      () => openRecord(record),
    )))
    if (!found.length) $('games').textContent = 'No games to display.'
    $('more').hidden = showCount >= found.length
  }

  function renderGames(games) {
    const name = profile?.username.toLowerCase()
    records = [...new Map(games.map(record => [record.id, record])).values()].flatMap(record => {
      const headers = tags(record.pgn)
      const side = headers.White?.toLowerCase() === name ? 'w' : headers.Black?.toLowerCase() === name ? 'b' : null
      if (!side || !['1-0', '0-1', '1/2-1/2'].includes(headers.Result)) return []
      return [{
        ...record, tags: headers, side, opening: record.opening || headers.Opening || headers.ECO,
        title: `${headers.White} vs ${headers.Black}`,
        key: `scout:${profile.site}:${name}:${record.id}`,
      }]
    })
    const counts = { wins: 0, draws: 0, losses: 0 }
    const openings = new Map()
    for (const record of records) {
      const result = record.tags.Result
      counts[result === '1/2-1/2' ? 'draws' : result === (record.side === 'w' ? '1-0' : '0-1') ? 'wins' : 'losses']++
      if (record.opening) openings.set(record.opening, (openings.get(record.opening) ?? 0) + 1)
    }
    $('summary').replaceChildren(...Object.entries({ games: records.length, ...counts }).map(([label, number]) => {
      const metric = document.createElement('span')
      metric.textContent = `${number} ${number === 1 ? label.slice(0, -1) : label}`
      return metric
    }))
    $('openings').textContent = openings.size ? 'Most played: ' + [...openings].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([name, count]) => `${name} (${count})`).join(' · ') : ''
    $('speed').replaceChildren(new Option('All', ''), ...[...new Set(records.map(record => record.speed).filter(Boolean))].sort().map(speed => new Option(speed, speed)))
    showCount = 30
    renderList()
    controls()
  }

  function controls() {
    $('analyze').disabled = !engine || !records.length || running || syncing
    $('stop').disabled = !running
    for (const id of ['sync', 'site', 'user', 'limit']) $(id).disabled = !engine || running || syncing
    $('disconnect').disabled = !profile || running || syncing
  }

  async function sync(next, restore = false) {
    syncing = true
    controls()
    $('status').textContent = 'Fetching public game history…'
    try {
      if (restore) renderGames(await engine.history({ ...next, cached: true }))
      const games = await engine.history(next)
      if (!restore) {
        reviewed.clear()
        $('patterns').replaceChildren()
        $('progress').textContent = ''
      }
      profile = next
      localStorage.setItem(profileKey, JSON.stringify(profile))
      renderGames(games)
      $('status').textContent = `${records.length} finished games synced for ${next.username}. History refreshes when ShackFish opens.`
    } catch (error) {
      $('status').textContent = records.length ? `${error.message} Showing ${records.length} cached games.` : error.message
    } finally {
      syncing = false
      controls()
    }
  }

  $('form').onsubmit = event => {
    event.preventDefault()
    sync({ site: $('site').value, username: $('user').value.trim(), limit: Number($('limit').value) })
  }
  $('disconnect').onclick = () => {
    profile = null
    localStorage.removeItem(profileKey)
    reviewed.clear()
    renderGames([])
    $('user').value = ''
    $('patterns').replaceChildren()
    $('status').textContent = 'Disconnected.'
    $('progress').textContent = ''
  }
  $('filter').oninput = $('speed').onchange = () => { showCount = 30; renderList() }
  $('more').onclick = () => { showCount += 30; renderList() }
  $('stop').onclick = () => { cancelled = true; engine.stopScouting() }
  $('analyze').onclick = async () => {
    running = true
    cancelled = false
    controls()
    const groups = new Map()
    const sample = records.slice(0, Number($('sample').value))
    let done = 0
    let failed = 0
    $('patterns').replaceChildren()
    for (const record of sample) {
      if (cancelled) break
      $('progress').textContent = `Reviewed ${done} / ${sample.length} · ${record.title}`
      try {
        const game = gameFor(record)
        const result = game.reviewResults?.length === game.moves.length + 1 ? game.reviewResults :
          await engine.scoutReview({ fen: game.start, moves: game.moves.map(uci) })
        if (!result || cancelled) break
        reviewed.set(record.key, result)
        for (const item of patterns({ ...game, reviewResults: result }, result, record.side)) {
          if (!groups.has(item.theme)) groups.set(item.theme, [])
          groups.get(item.theme).push(item)
        }
        done++
      } catch { failed++ }
    }
    for (const [theme, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      const heading = document.createElement('h3')
      heading.textContent = `${theme} · ${items.length}`
      $('patterns').append(heading, ...items.sort((a, b) => b.item.loss - a.item.loss).slice(0, 4).map(item =>
        button(`${item.game.title} · ${moveLabel(item.game.moves[item.index])} · ${item.item.label}. ${item.detail}`,
          () => showGame(item.game, item.index + 1))))
    }
    $('progress').textContent = `${cancelled ? 'Stopped. ' : ''}${done} ${done === 1 ? 'game' : 'games'} reviewed.${failed ? ` ${failed} could not be reviewed.` : ''}${done && !groups.size ? ' No costly moves detected for this player.' : ''}`
    running = false
    controls()
  }
  renderGames([])
  try {
    profile = JSON.parse(localStorage.getItem(profileKey))
    if (profile && engine) {
      $('site').value = profile.site
      $('user').value = profile.username
      $('limit').value = profile.limit
      sync(profile, true)
    }
  } catch { profile = null }
}
