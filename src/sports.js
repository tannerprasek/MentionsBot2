// "Is the game on?" for NHL teams: live score and clock, or the next game, plus the TV channels
// carrying it. Data from the NHL's public API (api-web.nhle.com).
import { tvScore } from './tvmatch.js'

const API = 'https://api-web.nhle.com/v1'
const get = async (path) => {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`NHL API HTTP ${res.status}`)
  return res.json()
}

// --- Teams ---

let teams = null
let teamsAt = 0
async function loadTeams () {
  if (teams && Date.now() - teamsAt < 24 * 3600_000) return teams
  const { standings } = await get('/standings/now')
  teams = standings.map((t) => ({
    abbr: t.teamAbbrev.default,
    name: t.teamName.default, // "Winnipeg Jets"
    common: t.teamCommonName.default, // "Jets"
    place: t.placeName.default // "Winnipeg"
  }))
  teamsAt = Date.now()
  return teams
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
// Words people add around a team name: "is the jets game on tonight", "jets score".
const FILLER = /\b(is|are|the|game|games|score|scores|tonight|today|now|on|playing|play|watch|hockey|nhl|match|live|when|what|time|next)\b/g

const NICKNAMES = {
  leafs: 'TOR', habs: 'MTL', sens: 'OTT', canes: 'CAR', bolts: 'TBL', pens: 'PIT', caps: 'WSH', avs: 'COL',
  hawks: 'CHI', wings: 'DET', nucks: 'VAN', preds: 'NSH', isles: 'NYI', knights: 'VGK', jackets: 'CBJ', sabres: 'BUF',
  'la kings': 'LAK', 'ny rangers': 'NYR', 'ny islanders': 'NYI', 'nj devils': 'NJD', 'tampa': 'TBL', 'tb lightning': 'TBL', 'sj sharks': 'SJS'
}
// Team names that are also common movie/show titles only count with a hint like "game" or the city.
const AMBIGUOUS = new Set(['predators', 'wild', 'lightning', 'kings', 'stars', 'avalanche', 'flames', 'devils', 'rangers', 'sharks', 'ducks', 'kraken', 'panthers', 'blues', 'hurricanes'])

// The NHL team a request names ("Winnipeg Jets", "jets", "the jets game", "leafs"), or null.
export async function findTeam (text) {
  const raw = norm(text)
  const q = norm(raw.replace(FILLER, ' '))
  if (!q) return null
  const hinted = q !== norm(raw.replace(/\bthe\b/g, ' '))
  const list = await loadTeams()
  if (NICKNAMES[q]) return list.find((t) => t.abbr === NICKNAMES[q]) || null
  const exact = list.find((t) => [t.name, t.place, t.abbr].some((n) => norm(n) === q)) ||
    list.find((t) => norm(t.common) === q && (hinted || !AMBIGUOUS.has(q)))
  if (exact) return exact
  if (AMBIGUOUS.has(q) && !hinted) return null
  let best = null
  let bestScore = 0.9
  for (const t of list) {
    const s = Math.max(tvScore(q, t.name), tvScore(q, t.common))
    if (s > bestScore) { best = t; bestScore = s }
  }
  return best
}

// --- Games ---

const NETWORKS = {
  SN: 'Sportsnet', SN1: 'Sportsnet One', SN360: 'Sportsnet 360', SNE: 'Sportsnet East', SNO: 'Sportsnet Ontario', SNW: 'Sportsnet West', SNP: 'Sportsnet Pacific',
  CBC: 'CBC', CITY: 'Citytv', TVAS: 'TVA Sports', TVAS2: 'TVA Sports 2', RDS: 'RDS', RDS2: 'RDS 2',
  'ESPN+': 'ESPN+', ESPN: 'ESPN', ESPN2: 'ESPN2', ABC: 'ABC', TNT: 'TNT', truTV: 'truTV', MAX: 'Max', NHLN: 'NHL Network', 'NHL Network': 'NHL Network'
}
const COUNTRY = { CA: 'Canada', US: 'US' }
const network = (b) => NETWORKS[b.network] || b.network

function channels (game) {
  const list = (game.tvBroadcasts || []).map((b) => `${network(b)} (${COUNTRY[b.countryCode] || b.countryCode})`)
  return [...new Set(list)]
}
const join = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
const ordinal = (n) => ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] || `${n}th`)
const nameOf = (side) => side.commonName?.default || side.abbrev

function when (iso) {
  const d = new Date(iso)
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 24 * 3600_000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `tonight at ${time}`
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  return `${d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`
}

const LIVE = ['LIVE', 'CRIT']
const DONE = ['FINAL', 'OFF']

// Live period/clock for a game happening today.
async function liveDetails (id) {
  const { games = [] } = await get('/score/now')
  return games.find((g) => g.id === id) || null
}

// Picks the game that matters now: one in progress, else today's, else the next one.
async function relevantGames (abbr) {
  let { games = [], nextStartDate } = await get(`/club-schedule/${abbr}/week/now`)
  const upcoming = () => games.filter((g) => !DONE.includes(g.gameState))
  if (!upcoming().length && nextStartDate) games = games.concat((await get(`/club-schedule/${abbr}/week/${nextStartDate}`)).games || [])
  const today = new Date().toDateString()
  const live = games.find((g) => LIVE.includes(g.gameState))
  const finishedToday = games.find((g) => DONE.includes(g.gameState) && new Date(g.startTimeUTC).toDateString() === today)
  const next = games.filter((g) => !DONE.includes(g.gameState) && !LIVE.includes(g.gameState)).sort((a, b) => a.startTimeUTC.localeCompare(b.startTimeUTC))[0]
  return { live, finishedToday, next }
}

// A spoken answer about a team's game: live score, final, or when the next one is and where.
export async function gameReport (team) {
  const { live, finishedToday, next } = await relevantGames(team.abbr)
  const matchup = (g) => `${nameOf(g.awayTeam)} at ${nameOf(g.homeTeam)}`
  const score = (g) => `${nameOf(g.awayTeam)} ${g.awayTeam.score ?? 0}, ${nameOf(g.homeTeam)} ${g.homeTeam.score ?? 0}`
  const on = (g) => (channels(g).length ? ` It's on ${join(channels(g))}.` : '')

  if (live) {
    const d = await liveDetails(live.id).catch(() => null) || live
    const p = d.periodDescriptor || {}
    const clock = d.clock || {}
    const period = p.periodType === 'OT' ? 'overtime' : p.periodType === 'SO' ? 'the shootout' : `the ${ordinal(p.number || 1)}`
    const where = clock.inIntermission ? `${ordinal(p.number || 1)} intermission` : clock.timeRemaining ? `${clock.timeRemaining} left in ${period}` : `in ${period}`
    return { state: 'live', game: d, speak: `${matchup(d)} is live: ${score(d)}, ${where}.${on(live)}` }
  }
  if (finishedToday) {
    const tail = next ? ` Next ${team.common} game: ${matchup(next)}, ${when(next.startTimeUTC)}.${on(next)}` : ''
    return { state: 'final', game: finishedToday, speak: `Final: ${score(finishedToday)}.${tail}` }
  }
  if (next) {
    const today = new Date(next.startTimeUTC).toDateString() === new Date().toDateString()
    return { state: today ? 'today' : 'upcoming', game: next, speak: `${today ? '' : `Next ${team.common} game: `}${matchup(next)}, ${when(next.startTimeUTC)}.${on(next)}` }
  }
  return { state: 'none', speak: `I couldn't find an upcoming ${team.name} game.` }
}
