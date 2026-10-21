import WebTorrent from 'webtorrent'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

// Downloads are temporary: they're deleted when playback stops, and leftovers are cleared on start.
// Only CastBot's own folder is ever emptied: the default ./downloads, or a custom DOWNLOAD_DIR
// that carries the marker file (so pointing it at an existing folder never wipes that folder).
const MARKER = '.castbot-temp'
const dir = () => path.resolve(config.downloadDir)

export function clearDownloads () {
  const d = dir()
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, MARKER), 'Temporary CastBot downloads. Emptied automatically.\n')
    return
  }
  if (!fs.existsSync(path.join(d, MARKER))) {
    if (process.env.DOWNLOAD_DIR && fs.readdirSync(d).length) return console.warn(`[torrent] ${d} wasn't created by CastBot; not emptying it`)
    fs.writeFileSync(path.join(d, MARKER), 'Temporary CastBot downloads. Emptied automatically.\n')
  }
  for (const name of fs.readdirSync(d)) {
    if (name !== MARKER) fs.rmSync(path.join(d, name), { recursive: true, force: true })
  }
}

const VIDEO = /\.(mp4|mkv|m4v|webm|avi|mov)$/i
const client = new WebTorrent()
client.on('error', (err) => console.error('[torrent]', err.message))

let current = null // { torrent, file } being watched
let preload = null // { torrent, file, key } next episode, downloading ahead of time

export function currentFile () {
  return current?.file
}

export function stats () {
  if (!current) return null
  const t = current.torrent
  return {
    name: current.file.name,
    progress: Math.round(current.file.progress * 1000) / 10,
    downloadSpeedMBs: Math.round(t.downloadSpeed / 1024 / 10.24) / 100,
    peers: t.numPeers
  }
}

function removeAndDelete (t) {
  return new Promise((resolve) => client.remove(t, { destroyStore: true }, () => {
    if (t.name) fs.rmSync(path.join(dir(), t.name), { recursive: true, force: true })
    resolve()
  }))
}

// Stops and deletes everything: the torrent being watched and any preloaded next episode.
// Stops and deletes every torrent, including a preload still fetching its metadata,
// optionally keeping one that's about to be reused.
export async function stopTorrent (keep = null) {
  current = null
  preload = null
  for (const t of [...client.torrents]) {
    if (t !== keep) await removeAndDelete(t).catch((err) => console.error('[torrent] cleanup', err.message))
  }
}

const whenReady = (t, timeoutMs) => (t.ready ? Promise.resolve(t) : new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for torrent metadata (no peers?)')), timeoutMs)
  t.once('ready', () => { clearTimeout(timer); resolve(t) })
  t.once('error', (err) => { clearTimeout(timer); reject(err) })
}))

// Season/episode from a file name like "Show.S02E05.1080p.mkv" or "Show 2x05.mkv".
export function episodeOf (name) {
  const m = name.match(/s(\d{1,2})[ ._-]?e(\d{1,3})/i) || name.match(/\b(\d{1,2})x(\d{2,3})\b/i)
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null
}

const isVideo = (f) => VIDEO.test(f.name) && !/sample/i.test(f.name)
const isEpisode = (f, req) => {
  const ep = episodeOf(f.name)
  return Boolean(ep && ep.season === req.season && ep.episode === req.episode)
}

function pickFile (files, req) {
  let videos = files.filter(isVideo)
  if (req.episode) {
    const match = videos.filter((f) => isEpisode(f, req))
    if (match.length) videos = match
  }
  return videos.sort((a, b) => b.length - a.length)[0]
}

function addTorrent (torrentId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeAndDelete(torrent).catch(() => {})
      reject(new Error('Timed out waiting for torrent metadata (no peers?)'))
    }, timeoutMs)
    const torrent = client.add(torrentId, { path: dir(), deselect: true }, (t) => { clearTimeout(timer); resolve(t) })
    torrent.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

export async function startTorrent (torrentId, req, timeoutMs = 90_000) {
  // The same torrent may already be here (preloaded as the next episode, or the season pack
  // being watched): reuse it, which also keeps what it already downloaded.
  const existing = await client.get(torrentId).catch(() => null)
  await stopTorrent(existing)
  const t = existing ? await whenReady(existing, timeoutMs) : await addTorrent(torrentId, timeoutMs)
  if (existing) console.log(`[torrent] reusing ${t.name}, already downloading`)
  const file = pickFile(t.files, req)
  if (!file) {
    await removeAndDelete(t).catch(() => {})
    throw new Error('No playable video file in torrent')
  }
  // A multi-episode torrent without the requested episode would play the wrong one.
  if (req.episode && !isEpisode(file, req) && t.files.filter(isVideo).length > 1) {
    await removeAndDelete(t).catch(() => {})
    const err = new Error(`That torrent doesn't contain season ${req.season} episode ${req.episode}`)
    err.wrongEpisode = true
    throw err
  }
  for (const f of t.files) if (f !== file) f.deselect()
  file.select()
  current = { torrent: t, file }
  return file
}

// A season pack already being watched may hold the requested episode.
export function fileInCurrent (req) {
  return current?.torrent.files.find((f) => isVideo(f) && isEpisode(f, req)) || null
}

export function switchToFile (file) {
  if (!current) return
  if (current.file !== file) current.file.deselect()
  file.select()
  current.file = file
}

// Starts downloading the next episode in the background, keeping the current one playing.
export async function preloadTorrent (torrentId, req, key, timeoutMs = 120_000) {
  if (preload) { const old = preload.torrent; preload = null; if (old !== current?.torrent) await removeAndDelete(old).catch(() => {}) }
  const existing = await client.get(torrentId).catch(() => null)
  const t = existing ? await whenReady(existing, timeoutMs) : await addTorrent(torrentId, timeoutMs)
  // Only the exact episode: a wrong file here would later play as "next".
  const file = t.files.find((f) => isVideo(f) && isEpisode(f, req))
  if (!file) { if (t !== current?.torrent) await removeAndDelete(t).catch(() => {}); return null }
  file.select()
  preload = { torrent: t, file, key }
  return file
}

export const preloadedFor = (key) => (preload?.key === key ? preload.file : null)

// Makes the preloaded episode the one being watched, deleting the previous torrent.
export async function promotePreload () {
  if (!preload) return null
  const old = current?.torrent
  current = { torrent: preload.torrent, file: preload.file }
  preload = null
  if (old && old !== current.torrent) await removeAndDelete(old).catch(() => {})
  return current.file
}

// Downloads the start of the video (or the resume point) and its tail before playback, so the TV
// doesn't stall a few seconds in. Gives up waiting after timeoutMs and plays anyway.
export async function prebuffer (file, startRatio = 0, onProgress, timeoutMs = 120_000) {
  const len = file.length
  const MB = 1024 * 1024
  const head = Math.min(len, Math.max(8 * MB, Math.min(48 * MB, len * 0.02)))
  const start = Math.floor(Math.min(Math.max(0, startRatio), 0.98) * len)
  const ranges = [[start, Math.min(len - 1, start + head - 1)]]
  const tail = Math.min(4 * MB, len)
  if (start + head < len - tail) ranges.push([len - tail, len - 1]) // MP4/MKV indexes often sit at the end
  if (start > 4 * MB) ranges.push([0, 4 * MB - 1]) // and headers at the start, needed when resuming
  const total = ranges.reduce((n, [a, b]) => n + b - a + 1, 0)
  let got = 0
  const streams = []
  const done = Promise.all(ranges.map(([a, b]) => new Promise((resolve) => {
    const st = file.createReadStream({ start: a, end: b })
    streams.push(st)
    st.on('data', (c) => { got += c.length; onProgress?.(Math.min(1, got / total)) })
    st.on('end', resolve)
    st.on('error', resolve)
  })))
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  const r = await Promise.race([done, timedOut])
  for (const st of streams) st.destroy()
  if (r === 'timeout') console.log('[torrent] buffering took too long; starting anyway')
}
