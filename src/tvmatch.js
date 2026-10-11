// Fuzzy TV-name matching, so "the frame", "frame tv" or "living rom" still find the right device.
const STOP = new Set(['tv', 'the', 'my', 'on', 'in', 'a'])
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t))

function lev (a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

const sim = (a, b) => (a || b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 1)

export function tvScore (query, name) {
  const q = norm(query)
  const n = norm(name)
  if (!q) return 0
  if (q === n) return 1
  const qt = tokens(query)
  const nt = tokens(name)
  const qs = norm(qt.join(''))
  const ns = norm(nt.join(''))
  if (qs && (qs === ns)) return 0.98
  if (qs.length >= 3 && (ns.includes(qs) || qs.includes(ns))) return 0.9
  const perToken = qt.length && nt.length
    ? qt.reduce((sum, t) => sum + Math.max(...nt.map((u) => sim(t, u))), 0) / qt.length
    : 0
  return Math.max(perToken, sim(qs || q, ns || n))
}

export const MATCH_THRESHOLD = 0.6

// Returns the index of the best-matching name, or -1 when nothing is close enough.
export function bestTv (query, names) {
  let best = -1
  let bestScore = MATCH_THRESHOLD
  names.forEach((name, i) => {
    const s = tvScore(query, name)
    if (s > bestScore || (s === bestScore && best === -1)) { best = i; bestScore = s }
  })
  return best
}
