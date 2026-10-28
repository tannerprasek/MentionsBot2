// What's playing, and everything that depends on knowing it: resume where you left off,
// next episode (on request and automatically), preloading the next episode, and buffering.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { search, resolveTorrent } from './search.js'
import {
  startTorrent, stopTorrent, episodeOf, fileInCurrent, switchToFile,
  preloadTorrent, preloadedFor, promotePreload, prebuffer
} from './torrent.js'
import { playOn, stopPlayback, progress as tvProgress, canResume, onPlaybackFinished } from './tvs.js'

const log = (...a) => console.log('[player]', ...a)

// --- Watch history: positions per movie/episode, and the last episode watched per show ---

const HISTORY_FILE = path.resolve(process.env.HISTORY_FILE || './history.json')
let history = { items: {}, shows: {} }
try { history = { items: {}, shows: {}, ...JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } } catch {}

let saveTimer = null
function saveHistory () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const keys = Object.keys(history.items)
    // Keep the 500 most recent entries.
    if (keys.length > 500) {
      keys.sort((a, b) => history.items[a].updated - history.items[b].updated).slice(0, keys.length - 500).forEach((k) => delete history.items[k])
    }
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)) } catch (err) { log('saving history:', err.message) }
  }, 1000)
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// Shows that share a name (the US, UK and Australian "The Traitors") keep separate history.
const showKey = (title, variant) => norm(title) + (variant ? ' ' + String(variant).toLowerCase() : '')
const keyOf = (title, season, episode, variant) => showKey(title, variant) + (season ? ` s${season}e${episode || 0}` : '')
const pad = (n) => String(n).padStart(2, '0')
const epQuery = (title, s, e) => `${title} S${pad(s)}E${pad(e)}`
const epLabel = (s, e) => (s && e ? `season ${s} episode ${e}` : '')
const minutes = (sec) => Math.max(1, Math.round(sec / 60))

function resumePoint (key, parsed) {
  const item = history.items[key]
  if (parsed.fromStart || !item || item.finished || !item.duration) return null
  if (item.position < 60 || item.position > item.duration - 120) return null
  return { startAt: item.position, ratio: item.position / item.duration }
}

// Fills in which episode a bare show request means ("bluey" → the episode after the last one
// finished, or the one left unfinished) and where to resume.
export function plan (parsed) {
  const out = { ...parsed }
  if (!out.season) {
    const show = history.shows[showKey(out.title, out.variant)]
    if (show) {
      const next = show.finished ? { season: show.season, episode: show.episode + 1 } : show
      Object.assign(out, { season: next.season, episode: next.episode, isSeries: true, query: epQuery(out.title, next.season, next.episode), continued: true })
    }
  }
  return { parsed: out, resume: resumePoint(keyOf(out.title, out.season, out.episode, out.variant), out) }
}

// What's been watched of a show, for the episode guide: progress per "SxE" and where to continue.
export function watchState (title, variant) {
  const t = showKey(title, variant)
  const episodes = {}
  for (const [k, v] of Object.entries(history.items)) {
    const m = k.match(/^(.*) s(\d+)e(\d+)$/)
    if (m && m[1] === t) episodes[`${m[2]}x${m[3]}`] = { position: v.position, duration: v.duration, finished: Boolean(v.finished) }
  }
  const show = history.shows[t]
  const next = show && (show.finished ? { season: show.season, episode: show.episode + 1 } : { season: show.season, episode: show.episode })
  return { episodes, continue: next || null }
}

// --- Playback ---

let now = null // { title, season, episode, isSeries, key, device, release, fileName, nearEnd, preloadStarted }
let last = null // what played most recently, for "next" after it stopped
let progressInfo = null // { position, duration, state }
let statusFn = () => {}
let busy = false

export const nowPlaying = () => now
export const lastPlayed = () => now || last
export const progress = () => progressInfo
export function onStatus (fn) { statusFn = fn }

const streamUrl = (file, device) =>
  `http://${config.publicHost}:${config.port}/stream/${encodeURIComponent(file.name)}${device.ref ? '?cast=1' : ''}`

// Plays a torrent search result (or a file already downloading) on a TV.
export async function start ({ parsed, result, results, device, resume, file: readyFile }) {
  const tv = device.name
  const base = { title: parsed.title, release: result?.title, tv }
  if (now) last = now
  now = null
  progressInfo = null
  try {
    statusFn({ state: 'connecting', ...base })
    // Try the top results in turn when one turns out not to contain the requested episode.
    let file = readyFile
    const candidates = results?.length ? results.slice(0, 3) : [result]
    for (const r of readyFile ? [] : candidates) {
      try {
        file = await startTorrent(await resolveTorrent(r.link), parsed)
        result = r
        base.release = r.title
        break
      } catch (err) {
        if (!err.wrongEpisode || r === candidates[candidates.length - 1]) throw err
        log(`skipping ${r.title}: ${err.message}`)
      }
    }
    const ep = episodeOf(file.name)
    const season = parsed.season || ep?.season
    const episode = parsed.episode || ep?.episode
    const isSeries = Boolean(season && episode)
    const key = keyOf(parsed.title, season, episode, parsed.variant)
    if (resume === undefined) resume = resumePoint(key, parsed)
    if (resume && !(await canResume(device))) resume = null
    const info = { ...base, season, episode, file: file.name }

    let lastPct = -1
    await prebuffer(file, resume?.ratio || 0, (f) => {
      const pct = Math.floor(f * 100)
      if (pct >= lastPct + 5) { lastPct = pct; statusFn({ state: 'buffering', ...info, buffered: pct }) }
    })

    await playOn(device, streamUrl(file, device), parsed.title, file.name, resume?.startAt || 0)
    now = { title: parsed.title, variant: parsed.variant, season, episode, isSeries, key, device, release: result?.title, fileName: file.name, nearEnd: false, preloadStarted: false }
    last = now
    progressInfo = resume ? { position: resume.startAt, duration: resume.startAt / resume.ratio, state: 'playing' } : null
    if (isSeries) {
      history.shows[showKey(parsed.title, parsed.variant)] = { season, episode, finished: false }
      saveHistory()
    }
    statusFn({ state: 'playing', ...info, resumedAt: resume?.startAt })
  } catch (err) {
    console.error(err.stack)
    statusFn({ state: 'error', title: parsed.title, error: err.message })
  }
}

// Plays a direct video/stream address on a TV: nothing to download, so just hand it over.
export async function startDirect ({ url, title, fileName, mime, device }) {
  const tv = device.name
  if (now) last = now
  now = null
  progressInfo = null
  try {
    statusFn({ state: 'connecting', title, tv })
    await stopTorrent() // drops a previous download; nothing is downloaded for a link
    const key = keyOf(title, 0, 0, 'link')
    let resume = resumePoint(key, {})
    if (resume && !(await canResume(device))) resume = null
    await playOn(device, url, title, fileName, resume?.startAt || 0, mime)
    now = { title, isSeries: false, key, device, release: url, fileName, nearEnd: false, preloadStarted: false }
    last = now
    progressInfo = null
    statusFn({ state: 'playing', title, tv, file: fileName, release: url, resumedAt: resume?.startAt })
  } catch (err) {
    console.error(err.stack)
    statusFn({ state: 'error', title, error: err.message })
  }
}

export async function stop () {
  if (now) last = now
  now = null
  progressInfo = null
  await stopPlayback().catch(() => {})
  await stopTorrent()
}

const nextCandidates = (s, e) => [{ season: s, episode: e + 1 }, { season: s + 1, episode: 1 }]

// Finds the next episode and starts it on the same TV. Resolves once it knows what will play
// (so Siri can answer quickly); playback itself continues in the background.
export async function playNext (prev = lastPlayed()) {
  if (!prev?.isSeries) return { ok: false, speak: "There's no show to continue." }
  for (const c of nextCandidates(prev.season, prev.episode)) {
    const parsed = { title: prev.title, variant: prev.variant, ...c, isSeries: true, query: epQuery(prev.title, c.season, c.episode) }
    const label = `${prev.title}, ${epLabel(c.season, c.episode)}`
    const speak = `Playing ${label} on ${prev.device.name}.`
    const opts = { parsed, device: prev.device, resume: resumePoint(keyOf(prev.title, c.season, c.episode, prev.variant), parsed) }

    const inPack = fileInCurrent(parsed)
    if (inPack) {
      log(`next: ${label} is in the season pack already downloading`)
      switchToFile(inPack)
      start({ ...opts, file: inPack, result: { title: inPack.name } })
      return { ok: true, speak }
    }
    if (preloadedFor(keyOf(prev.title, c.season, c.episode, prev.variant))) {
      log(`next: ${label} was preloaded`)
      const file = await promotePreload()
      start({ ...opts, file, result: { title: file.name } })
      return { ok: true, speak }
    }
    const results = await search(parsed).catch(() => [])
    if (results.length) {
      log(`next: ${label} → ${results[0].title}`)
      start({ ...opts, result: results[0], results })
      return { ok: true, speak }
    }
  }
  return { ok: false, speak: `I couldn't find the next episode of ${prev.title}.` }
}

// Downloads the next episode in the background while the current one plays.
async function preloadNext (cur) {
  for (const c of nextCandidates(cur.season, cur.episode)) {
    const parsed = { title: cur.title, variant: cur.variant, ...c, isSeries: true, query: epQuery(cur.title, c.season, c.episode) }
    const inPack = fileInCurrent(parsed)
    if (inPack) { inPack.select(); log(`preloading ${epLabel(c.season, c.episode)} from the season pack`); return }
    // Try the top few results: a season pack without this episode is skipped.
    const results = await search(parsed).catch(() => [])
    for (const r of results.slice(0, 3)) {
      const file = await preloadTorrent(await resolveTorrent(r.link), parsed, keyOf(cur.title, c.season, c.episode, cur.variant)).catch(() => null)
      if (file) { log(`preloading ${epLabel(c.season, c.episode)}: ${file.name}`); return }
    }
  }
}

// In the last 90 seconds: quietly download the start of the next episode (and its index at the
// end of the file) so it begins the moment this one ends.
async function bufferNext (cur) {
  await cur.preloading?.catch(() => {}) // a preload that started late may still be fetching
  for (const c of nextCandidates(cur.season, cur.episode)) {
    const parsed = { title: cur.title, variant: cur.variant, ...c, isSeries: true }
    const file = fileInCurrent(parsed) || preloadedFor(keyOf(cur.title, c.season, c.episode, cur.variant))
    if (file) {
      log(`buffering ${epLabel(c.season, c.episode)} ahead of time`)
      await prebuffer(file, 0, null, 85_000)
      return
    }
  }
}

async function finished (reason) {
  if (!now || busy) return
  busy = true
  try {
    const prev = now
    log(`${prev.title} ${epLabel(prev.season, prev.episode)} finished (${reason})`)
    history.items[prev.key] = { ...history.items[prev.key], finished: true, position: 0, updated: Date.now() }
    if (prev.isSeries) history.shows[showKey(prev.title, prev.variant)] = { season: prev.season, episode: prev.episode, finished: true }
    saveHistory()
    now = null
    progressInfo = null
    if (config.autoNext && prev.isSeries) {
      const r = await playNext(prev)
      if (r.ok) return log(r.speak)
    }
    await stopTorrent()
    statusFn({ state: 'idle' })
  } finally {
    busy = false
  }
}

onPlaybackFinished(() => finished('TV reported the end'))

// Every 10 seconds: save the position, notice the end on TVs that don't announce it,
// and start downloading the next episode 10 minutes before this one ends.
setInterval(async () => {
  const cur = now
  if (!cur || busy) return
  const p = await tvProgress().catch(() => null)
  if (cur !== now) return
  if (p && p.duration > 0) {
    progressInfo = p
    history.items[cur.key] = { position: p.position, duration: p.duration, finished: false, updated: Date.now() }
    saveHistory()
    if (p.position >= p.duration - 30) cur.nearEnd = true
    if (cur.isSeries && !cur.preloadStarted && p.duration - p.position < 600) {
      cur.preloadStarted = true
      cur.preloading = preloadNext(cur).catch((err) => log('preload failed:', err.message))
    }
    if (cur.isSeries && config.autoNext && !cur.nextBuffered && p.duration - p.position < 90) {
      cur.nextBuffered = true
      bufferNext(cur).catch((err) => log('buffering next failed:', err.message))
    }
  }
  const stoppedState = !p || ['stopped', 'idle'].includes(p.state)
  if (cur.nearEnd && stoppedState) finished('reached the end')
}, 10_000).unref()

// --- "What's playing?" ---

export function describe (status) {
  if (status.state === 'buffering') return `Getting ${status.title} ready on ${status.tv}, ${status.buffered || 0} percent buffered.`
  if (['searching', 'connecting'].includes(status.state)) return `Starting ${status.title}.`
  if (!now) return 'Nothing is playing.'
  const parts = [now.title]
  if (now.isSeries) parts.push(epLabel(now.season, now.episode))
  parts.push(`on ${now.device.name}`)
  const p = progressInfo
  if (p?.duration) {
    parts.push(`${minutes(p.position)} minutes in`)
    parts.push(`about ${minutes(p.duration - p.position)} minutes left`)
  }
  if (p?.state === 'paused') parts.push('paused')
  return parts.join(', ') + '.'
}

export const describeEpisode = (parsed) => epLabel(parsed.season, parsed.episode)
export const minutesOf = minutes
