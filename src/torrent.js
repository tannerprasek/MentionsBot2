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

let current = null // { torrent, file }

export function currentFile () {
  return current?.file
}

export function stats () {
  if (!current) return null
  const t = current.torrent
  return {
    name: current.file.name,
    progress: Math.round(t.progress * 1000) / 10,
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

export async function stopTorrent () {
  if (!current) return
  const t = current.torrent
  current = null
  await removeAndDelete(t).catch((err) => console.error('[torrent] cleanup', err.message))
}

function pickFile (files, req) {
  let videos = files.filter((f) => VIDEO.test(f.name) && !/sample/i.test(f.name))
  if (req.episode) {
    const re = new RegExp(`s0?${req.season}[ ._-]?e0?${req.episode}\\b|\\b${req.season}x0?${req.episode}\\b`, 'i')
    const match = videos.filter((f) => re.test(f.name))
    if (match.length) videos = match
  }
  return videos.sort((a, b) => b.length - a.length)[0]
}

export async function startTorrent (torrentId, req, timeoutMs = 90_000) {
  await stopTorrent()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeAndDelete(torrent).catch(() => {})
      reject(new Error('Timed out waiting for torrent metadata (no peers?)'))
    }, timeoutMs)

    const torrent = client.add(torrentId, { path: dir(), deselect: true }, (t) => {
      clearTimeout(timer)
      const file = pickFile(t.files, req)
      if (!file) {
        removeAndDelete(t).catch(() => {})
        return reject(new Error('No playable video file in torrent'))
      }
      file.select()
      current = { torrent: t, file }
      resolve(file)
    })
    torrent.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
