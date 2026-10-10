import WebTorrent from 'webtorrent'
import path from 'node:path'
import { config } from './config.js'

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

export async function stopTorrent () {
  if (!current) return
  const t = current.torrent
  current = null
  await new Promise((resolve) => client.remove(t, { destroyStore: false }, () => resolve()))
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
      client.remove(torrent, () => {})
      reject(new Error('Timed out waiting for torrent metadata (no peers?)'))
    }, timeoutMs)

    const torrent = client.add(torrentId, { path: path.resolve(config.downloadDir), deselect: true }, (t) => {
      clearTimeout(timer)
      const file = pickFile(t.files, req)
      if (!file) {
        client.remove(t, () => {})
        return reject(new Error('No playable video file in torrent'))
      }
      file.select()
      current = { torrent: t, file }
      resolve(file)
    })
    torrent.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
