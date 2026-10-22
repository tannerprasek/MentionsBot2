import { XMLParser } from 'fast-xml-parser'
import { config } from './config.js'
import { findProwlarrKey, prowlarrSearch } from './prowlarr.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })

function attrs (item) {
  const out = {}
  const list = [].concat(item['torznab:attr'] || [])
  for (const a of list) out[a.name] = a.value
  return out
}

function score (r, req) {
  const name = r.title.toLowerCase()
  if (r.seeders < config.minSeeders) return -1
  if (r.size > config.maxSizeGb * 1024 ** 3) return -1
  if (config.avoidHevc && /(x265|h\.?265|hevc)/.test(name)) return -1
  if (!config.allow4k && /(2160p|\b4k\b|uhd)/.test(name)) return -1
  if (/\b(cam|camrip|hdcam|ts|telesync|hdts)\b/.test(name)) return -1
  if (req.episode && !new RegExp(`s0?${req.season}e0?${req.episode}\\b`, 'i').test(name)) return -1

  let s = Math.log10(r.seeders + 1) * 10
  if (name.includes(config.preferredQuality.toLowerCase())) s += 15
  else if (/720p/.test(name)) s += 8
  if (/\.mp4|\bmp4\b/.test(name)) s += 3
  if (/web-?dl|webrip|bluray|brrip/.test(name)) s += 4
  return s
}

async function torznabSearch (req) {
  const url = new URL(config.torznabUrl)
  url.searchParams.set('apikey', config.torznabApiKey)
  url.searchParams.set('t', 'search')
  url.searchParams.set('q', req.query)
  url.searchParams.set('cat', req.isSeries ? '5000' : '2000')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Indexer search failed: HTTP ${res.status}`)
  const doc = parser.parse(await res.text())
  const items = [].concat(doc?.rss?.channel?.item || [])

  return items.map((item) => {
    const a = attrs(item)
    return {
      title: String(item.title),
      link: a.magneturl || item.link || item.enclosure?.url,
      seeders: Number(a.seeders || 0),
      size: Number(a.size || item.size || item.enclosure?.length || 0)
    }
  }).filter((r) => r.link)
}

// A Torznab URL set in Settings wins; otherwise search all indexers of the local Prowlarr.
// Country tags releases use for same-named shows ("The Traitors US S02E01").
const TAGS = ['US', 'UK', 'AU', 'NZ', 'CA', 'DE', 'FR', 'NL', 'IE']
const hasTag = (name, tag) => new RegExp(`[. _()\\[-]${tag}[. _()\\]-]`, 'i').test(name)
const tagOf = (variant) => (variant === 'GB' ? 'UK' : variant)

export async function search (req) {
  // A show sharing its name with another country's: search with the country tag first, and
  // always rank the wrong country's releases out.
  if (/^[A-Za-z]{2}$/.test(req.variant || '')) {
    const tag = tagOf(req.variant)
    const base = req.query.slice(req.title.length)
    const tagged = tag === 'UK' ? [] : await searchOnce({ ...req, query: `${req.title} ${tag}${base}` }).catch(() => [])
    const results = tagged.length ? tagged : await searchOnce(req)
    return results
      .filter((r) => !TAGS.filter((t) => t !== tag).some((t) => hasTag(r.title, t)))
      .map((r) => (hasTag(r.title, tag) ? { ...r, score: r.score + 20 } : r))
      .sort((a, b) => b.score - a.score)
  }
  return searchOnce(req)
}

async function searchOnce (req) {
  let results
  if (config.torznabUrl) {
    results = await torznabSearch(req)
  } else {
    const key = config.torznabApiKey || findProwlarrKey()
    if (!key) throw new Error('Prowlarr not found. Install it, or enter a Torznab URL in Settings')
    results = await prowlarrSearch(req, key)
  }

  return results
    .map((r) => ({ ...r, score: score(r, req) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
}

// Indexer download links often redirect to a magnet, which fetch can't follow.
export async function resolveTorrent (link) {
  if (link.startsWith('magnet:')) return link
  const res = await fetch(link, { redirect: 'manual' })
  const loc = res.headers.get('location')
  if (res.status >= 300 && res.status < 400 && loc) return resolveTorrent(loc)
  if (!res.ok) throw new Error(`Torrent download failed: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
