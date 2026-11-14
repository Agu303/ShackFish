const chessCom = 'https://api.chess.com'

async function response(url, accept = 'application/json') {
  const result = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'ShackFish desktop chess review' },
    redirect: 'error',
    signal: AbortSignal.timeout(90000),
  })
  if (result.status === 404) throw new Error('No public game history was found for that username.')
  if (result.status === 429) throw new Error('The chess site is limiting requests. Wait a minute and try again.')
  if (!result.ok) throw new Error(`The chess site returned HTTP ${result.status}.`)
  return result
}

async function history(site, username, limit) {
  if (!/^[\w-]{1,40}$/.test(username) || ![100, 300, 600].includes(limit)) {
    throw new Error('Enter a valid username and game limit.')
  }
  if (site === 'lichess') {
    const urls = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(username)}`)
    urls.search = new URLSearchParams({
      max: limit, pgnInJson: true, perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
      finished: true, ongoing: false, sort: 'dateDesc', clocks: false, evals: false, opening: true,
    })
    const result = await response(urls, 'application/x-ndjson')
    return (await result.text()).trim().split('\n').filter(Boolean).slice(0, limit)
      .map(line => JSON.parse(line)).filter(game => game.pgn)
      .map(game => ({ id: game.id, pgn: game.pgn, date: game.createdAt, speed: game.speed, opening: game.opening?.name }))
  }
  if (site !== 'chesscom') throw new Error('Choose Chess.com or Lichess.')
  const playerPath = `/pub/player/${username.toLowerCase()}/games/`
  const { archives } = await (await response(chessCom + playerPath + 'archives')).json()
  const games = []
  for (const archive of [...archives].reverse()) {
    const url = new URL(archive)
    if (url.origin !== chessCom || !url.pathname.startsWith(playerPath) || !/^\d{4}\/\d{2}$/.test(url.pathname.slice(playerPath.length))) continue
    const month = await (await response(url)).json()
    const finished = month.games.filter(game => game.rules === 'chess' && game.pgn && game.end_time)
    finished.sort((a, b) => b.end_time - a.end_time)
    for (const game of finished) {
      games.push({ id: game.uuid ?? game.url, pgn: game.pgn, date: game.end_time * 1000, speed: game.time_class })
    }
    if (games.length >= limit) break
  }
  return games.slice(0, limit)
}

module.exports = { history }
