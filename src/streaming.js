// Looks up where a title streams (JustWatch's public catalog) and matches it against the user's services.
import { tvScore } from './tvmatch.js'

export const SERVICES = {
  netflix: { name: 'Netflix', packages: ['netflix', 'netflixbasicwithads'] },
  disneyplus: { name: 'Disney+', packages: ['disneyplus'] },
  appletvplus: { name: 'Apple TV+', packages: ['appletvplus'] }
}

const QUERY = `query($c: Country!, $l: Language!, $f: TitleFilter) {
  popularTitles(country: $c, first: 5, filter: $f) {
    edges { node {
      objectType
      content(country: $c, language: $l) { title originalReleaseYear }
      offers(country: $c, platform: WEB) { monetizationType standardWebURL package { technicalName } }
    } }
  }
}`

// Returns { service, serviceName, url, title } for the first enabled service carrying the title, or null.
export async function findStreaming (req, enabled, country = 'US') {
  if (!enabled.length || !req.title) return null
  const res = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { c: country, l: 'en', f: { searchQuery: req.title } } }),
    signal: AbortSignal.timeout(6000)
  })
  if (!res.ok) throw new Error(`JustWatch HTTP ${res.status}`)
  const edges = (await res.json())?.data?.popularTitles?.edges || []

  const wantType = req.isSeries ? 'SHOW' : null
  const candidates = edges
    .map((e) => e.node)
    .filter((n) => n.content && (!wantType || n.objectType === wantType))
    .map((n) => ({ n, score: tvScore(req.title, n.content.title) }))
    .filter((c) => c.score >= 0.8)
    .sort((a, b) => b.score - a.score)
  const node = candidates[0]?.n
  if (!node) return null

  for (const key of enabled) {
    const svc = SERVICES[key]
    if (!svc) continue
    const offer = node.offers.find((o) => o.monetizationType === 'FLATRATE' && svc.packages.includes(o.package.technicalName))
    if (offer) return { service: key, serviceName: svc.name, url: offer.standardWebURL, title: node.content.title }
  }
  return null
}
