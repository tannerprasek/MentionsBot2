// DIAL (the "second screen" launch protocol Netflix co-created): starts an app on the TV with content.
import { onSsdp } from './ssdp.js'

const appUrls = new Map() // ip -> DIAL Application-URL

onSsdp(async ({ st, location, ip }) => {
  if (!st.includes('dial-multiscreen') || !location || appUrls.has(ip)) return
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) })
    const url = res.headers.get('application-url')
    if (url) appUrls.set(ip, url.endsWith('/') ? url : url + '/')
  } catch {}
})

// Samsung serves DIAL on :8080 even when it doesn't answer the SSDP search in time.
const appUrl = (ip) => appUrls.get(ip) || `http://${ip}:8080/ws/apps/`

// Opens a Netflix title. Resolves true when the TV accepted the launch.
export async function dialNetflix (ip, netflixUrl) {
  const id = netflixUrl.match(/title\/(\d+)/)?.[1]
  if (!id) return false
  const body = `m=${encodeURIComponent(`https://api.netflix.com/catalog/titles/movies/${id}`)}&source_type=12`
  try {
    const res = await fetch(appUrl(ip) + 'Netflix', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(8000)
    })
    console.log(`[dial] Netflix launch on ${ip}: HTTP ${res.status}`)
    return res.status === 200 || res.status === 201
  } catch (err) {
    console.log(`[dial] Netflix launch on ${ip} failed: ${err.message}`)
    return false
  }
}
