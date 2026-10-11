import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROWLARR_URL = process.env.PROWLARR_URL || 'http://localhost:9696'

// Where the Prowlarr installers keep config.xml, which holds the API key.
function configPaths () {
  const home = os.homedir()
  return [
    process.env.ProgramData && path.join(process.env.ProgramData, 'Prowlarr', 'config.xml'),
    'C:\\ProgramData\\Prowlarr\\config.xml',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Prowlarr', 'config.xml'),
    path.join(home, '.config', 'Prowlarr', 'config.xml'),
    path.join(home, 'Library', 'Application Support', 'Prowlarr', 'config.xml'),
    '/var/lib/prowlarr/config.xml'
  ].filter(Boolean)
}

export function findProwlarrKey () {
  for (const p of configPaths()) {
    try {
      const key = fs.readFileSync(p, 'utf8').match(/<ApiKey>([^<]+)<\/ApiKey>/)
      if (key) return key[1].trim()
    } catch {}
  }
  return ''
}

export async function prowlarrStatus (apiKey = findProwlarrKey()) {
  if (!apiKey) return { found: false, reason: 'Prowlarr not installed on this computer' }
  try {
    const res = await fetch(`${PROWLARR_URL}/api/v1/indexer?apikey=${apiKey}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { found: false, reason: `Prowlarr replied HTTP ${res.status}` }
    const indexers = (await res.json()).filter((i) => i.enable)
    return { found: true, indexers: indexers.map((i) => i.name) }
  } catch {
    return { found: false, reason: 'Prowlarr is installed but not running' }
  }
}

// Searches every enabled Prowlarr indexer at once.
export async function prowlarrSearch (req, apiKey) {
  const url = new URL(`${PROWLARR_URL}/api/v1/search`)
  url.searchParams.set('apikey', apiKey)
  url.searchParams.set('query', req.query)
  url.searchParams.set('type', 'search')
  url.searchParams.append('categories', req.isSeries ? '5000' : '2000')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Prowlarr search failed: HTTP ${res.status}`)
  return (await res.json())
    .filter((r) => r.protocol === 'torrent')
    .map((r) => ({
      title: String(r.title),
      link: r.magnetUrl || r.downloadUrl,
      seeders: Number(r.seeders || 0),
      size: Number(r.size || 0),
      indexer: r.indexer
    }))
    .filter((r) => r.link)
}
