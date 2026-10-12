// Show and episode data (seasons, titles, thumbnails) from TVmaze's free public API,
// cached on disk so the episode guide opens instantly and keeps working offline.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CACHE = path.resolve(process.env.CACHE_DIR || './cache')
const SHOW_DIR = path.join(CACHE, 'shows')
const IMG_DIR = path.join(CACHE, 'img')
fs.mkdirSync(SHOW_DIR, { recursive: true })
fs.mkdirSync(IMG_DIR, { recursive: true })

const DAY = 24 * 3600_000
const API = 'https://api.tvmaze.com'
const norm = (s) => s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '')

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const writeJson = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data)) } catch {} }

async function get (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`TVmaze HTTP ${res.status}`)
  return res.json()
}

// The show whose name is exactly what was asked for ("Bluey", "The Bear"), or null.
// An exact match keeps movies like "Tangled" from turning into "Rapunzel's Tangled Adventure".
export async function findShow (title) {
  const indexFile = path.join(SHOW_DIR, 'index.json')
  const index = readJson(indexFile) || {}
  const key = norm(title)
  const hit = index[key]
  if (hit && Date.now() - hit.at < 7 * DAY) return hit.id ? { id: hit.id, name: hit.name } : null

  const show = await get(`${API}/singlesearch/shows?q=${encodeURIComponent(title)}`)
  const match = show && norm(show.name) === key ? { id: show.id, name: show.name } : null
  index[key] = { ...(match || { id: null }), at: Date.now() }
  writeJson(indexFile, index)
  return match
}

const plain = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
const img = (url) => (url ? `/api/img?u=${encodeURIComponent(url)}` : null)

// Seasons and episodes for a show, refreshed once a day (cached copy used if TVmaze is down).
export async function getShow (id) {
  const file = path.join(SHOW_DIR, `${Number(id)}.json`)
  const cached = readJson(file)
  if (cached && Date.now() - cached.at < DAY) return cached.data
  let raw
  try {
    raw = await get(`${API}/shows/${Number(id)}?embed=episodes`)
  } catch (err) {
    if (cached) return cached.data
    throw err
  }
  if (!raw) return null
  const seasons = new Map()
  for (const e of raw._embedded?.episodes || []) {
    if (!e.season || !e.number) continue
    if (!seasons.has(e.season)) seasons.set(e.season, [])
    seasons.get(e.season).push({
      season: e.season,
      number: e.number,
      name: e.name,
      airdate: e.airdate,
      runtime: e.runtime,
      image: img(e.image?.medium),
      summary: plain(e.summary)
    })
  }
  const data = {
    id: raw.id,
    name: raw.name,
    year: raw.premiered?.slice(0, 4),
    poster: img(raw.image?.medium),
    summary: plain(raw.summary),
    seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => ({ season, episodes }))
  }
  writeJson(file, { at: Date.now(), data })
  return data
}

// Serves a TVmaze image from the local cache, downloading it the first time.
export async function cachedImage (url) {
  const u = new URL(url)
  if (u.hostname !== 'static.tvmaze.com') throw new Error('not a TVmaze image')
  const file = path.join(IMG_DIR, crypto.createHash('sha1').update(u.href).digest('hex') + path.extname(u.pathname))
  if (!fs.existsSync(file)) {
    const res = await fetch(u, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`image HTTP ${res.status}`)
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  return file
}
