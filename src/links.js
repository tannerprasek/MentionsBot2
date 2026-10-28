// Recognises a pasted link: a magnet, a .torrent, or a direct video/stream address.
import path from 'node:path'

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|m3u8|ts|mpd)$/i
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', m3u8: 'application/x-mpegURL', ts: 'video/mp2t', mpd: 'application/dash+xml' }

export const mimeForExt = (ext) => MIME[String(ext).replace(/^\./, '').toLowerCase()] || 'video/mp4'

// "The.Challenge.S42E04.1080p.WEB.h264-GRP" → "The Challenge"
export function cleanTitle (name) {
  const spaced = String(name).replace(/\.(mkv|mp4|avi|m4v|webm|mov|m3u8|mpd|ts|torrent)$/i, '').replace(/[._]+/g, ' ').trim()
  const cut = spaced.search(/\b(s\d{1,2}e\d{1,3}|\d{1,2}x\d{2,3}|(19|20)\d{2}|2160p|1080p|720p|480p|web|bluray|hdtv)\b/i)
  return (cut > 2 ? spaced.slice(0, cut) : spaced).trim() || spaced
}

// Finds a link anywhere in the text. null when there isn't one.
export function parseLink (text) {
  const m = String(text).match(/(magnet:\?\S+|https?:\/\/\S+)/i)
  if (!m) return null
  const raw = m[1].replace(/[)\]>.,;]+$/, '')
  if (/^magnet:/i.test(raw)) {
    const dn = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)).get('dn')
    return { kind: 'magnet', url: raw, name: dn || 'Magnet link', title: dn ? cleanTitle(dn) : 'Magnet link' }
  }
  let u
  try { u = new URL(raw) } catch { return null }
  const file = decodeURIComponent(path.basename(u.pathname) || u.hostname)
  // Generic file names (index.m3u8, watch, video) say nothing; name it after the site instead.
  const named = cleanTitle(file)
  const generic = /^(index|playlist|master|main|video|watch|stream|live|play|manifest|hls|[a-z]?\d*)$/i.test(named)
  const base = { url: u.href, name: file, title: generic ? u.hostname.replace(/^www\./, '') : named }
  if (/\.torrent$/i.test(u.pathname)) return { kind: 'torrent', ...base }
  if (VIDEO_EXT.test(u.pathname)) return { kind: 'direct', ...base, ext: path.extname(u.pathname).slice(1).toLowerCase() }
  return { kind: 'unknown', ...base }
}

// Settles an address with no recognisable ending by asking the server what it is.
export async function probeLink (link) {
  if (link.kind !== 'unknown') return link
  const ask = (init) => fetch(link.url, { redirect: 'follow', signal: AbortSignal.timeout(6000), ...init })
  let res = await ask({ method: 'HEAD' }).catch(() => null)
  if (!res || !res.ok) res = await ask({ method: 'GET', headers: { range: 'bytes=0-0' } }).catch(() => null)
  const type = (res?.headers.get('content-type') || '').toLowerCase()
  if (/video\/|mpegurl|dash\+xml/.test(type)) {
    const ext = /mpegurl/.test(type) ? 'm3u8' : /dash/.test(type) ? 'mpd' : type.includes('matroska') ? 'mkv' : type.includes('webm') ? 'webm' : 'mp4'
    return { ...link, kind: 'direct', ext }
  }
  if (/bittorrent/.test(type)) return { ...link, kind: 'torrent' }
  return { ...link, kind: 'page' }
}
