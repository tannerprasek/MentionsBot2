// Turns dictated text like "breaking bad season 2 episode 3" into a search query.
const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, first: 1, second: 2, third: 3
}
const num = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()])
const pad = (n) => String(n).padStart(2, '0')

export function parseRequest (text) {
  let t = text.trim().replace(/^(play|watch|stream|put on)\s+/i, '')
  let season, episode

  const sxe = t.match(/\bs(\d{1,2})\s*e(\d{1,3})\b/i)
  const spoken = t.match(/\bseason\s+(\w+)(?:\s*,?\s*episode\s+(\w+))?/i)
  if (sxe) {
    season = Number(sxe[1]); episode = Number(sxe[2])
    t = t.replace(sxe[0], '')
  } else if (spoken) {
    season = num(spoken[1])
    episode = spoken[2] ? num(spoken[2]) : undefined
    t = t.replace(spoken[0], '')
  }

  const title = t.replace(/\s+/g, ' ').replace(/[,.\s]+$/, '').trim()
  let query = title
  if (season && episode) query += ` S${pad(season)}E${pad(episode)}`
  else if (season) query += ` S${pad(season)}`
  return { title, season, episode, query, isSeries: Boolean(season) }
}
