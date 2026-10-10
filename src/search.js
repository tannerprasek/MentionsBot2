import { XMLParser } from 'fast-xml-parser'
import { config } from './config.js'

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

export async function search (req) {
  if (!config.torznabUrl) throw new Error('TORZNAB_URL is not configured')
  const url = new URL(config.torznabUrl)
  url.searchParams.set('apikey', config.torznabApiKey)
  url.searchParams.set('t', 'search')
  url.searchParams.set('q', req.query)
  url.searchParams.set('cat', req.isSeries ? '5000' : '2000')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Indexer search failed: HTTP ${res.status}`)
  const doc = parser.parse(await res.text())
  const items = [].concat(doc?.rss?.channel?.item || [])

  const results = items.map((item) => {
    const a = attrs(item)
    return {
      title: String(item.title),
      link: a.magneturl || item.link || item.enclosure?.url,
      seeders: Number(a.seeders || 0),
      size: Number(a.size || item.size || item.enclosure?.length || 0)
    }
  }).filter((r) => r.link)

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
