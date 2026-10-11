// LG webOS TVs: discovery via SSDP, app launching over LG's SSAP remote API (lgtv2).
import LGTV from 'lgtv2'
import { XMLParser } from 'fast-xml-parser'
import { onSsdp } from './ssdp.js'

const parser = new XMLParser({ ignoreAttributes: true })
const devices = new Map() // ip -> { name, ip }
const connections = new Map() // ip -> Promise<lgtv>

onSsdp(async ({ st, location, ip }) => {
  if (!st.includes('webos-second-screen') || devices.has(ip)) return
  devices.set(ip, { name: 'LG TV', ip, pending: true })
  try {
    const xml = await (await fetch(location, { signal: AbortSignal.timeout(4000) })).text()
    const name = String(parser.parse(xml)?.root?.device?.friendlyName || 'LG TV')
    devices.set(ip, { name, ip })
    console.log(`[lg] found "${name}" at ${ip}`)
  } catch {
    devices.delete(ip)
  }
})

export const lgDevices = () => [...devices.values()].filter((d) => !d.pending)

// The first connection shows a pairing prompt on the TV; the key it returns is saved via saveKey.
function connect (ip, clientKey, saveKey) {
  if (connections.has(ip)) return connections.get(ip)
  const p = new Promise((resolve, reject) => {
    const tv = LGTV({ host: ip, clientKey: clientKey || undefined, saveKey: (key, cb) => { saveKey(key); cb?.() }, reconnect: 0, timeout: 20_000 })
    const timer = setTimeout(() => { tv.disconnect(); reject(new Error('The LG TV did not respond. If it showed a pairing prompt, accept it and try again.')) }, 60_000)
    tv.on('connect', () => { clearTimeout(timer); resolve(tv) })
    tv.on('error', (err) => { clearTimeout(timer); reject(err) })
    tv.on('close', () => connections.delete(ip))
  })
  p.catch(() => connections.delete(ip))
  connections.set(ip, p)
  return p
}

const request = (tv, uri, payload) => new Promise((resolve, reject) => tv.request(uri, payload, (err, res) => (err ? reject(err) : resolve(res))))

const APPS = { netflix: 'netflix', disneyplus: 'com.disney.disneyplus-prod', appletvplus: 'com.apple.appletv' }

function contentId (service, url) {
  if (service === 'netflix') {
    const id = url.match(/title\/(\d+)/)?.[1]
    return id ? `m=https://www.netflix.com/title/${id}&source_type=4` : undefined
  }
  return url
}

export async function lgOpenApp (ip, service, url, keys) {
  const tv = await connect(ip, keys.get(ip), (k) => keys.set(ip, k))
  await request(tv, 'ssap://system.launcher/launch', { id: APPS[service], contentId: contentId(service, url) })
  return { deep: service === 'netflix' }
}

// Fallback player when the TV has no DLNA renderer.
export async function lgPlay (ip, url, title, mime, keys) {
  const tv = await connect(ip, keys.get(ip), (k) => keys.set(ip, k))
  await request(tv, 'ssap://media.viewer/open', { target: url, title, mimeType: mime })
}

export async function lgControl (ip, action, value, keys) {
  const tv = await connect(ip, keys.get(ip), (k) => keys.set(ip, k))
  if (action === 'volume') return request(tv, 'ssap://audio/setVolume', { volume: Math.round(Number(value) * 100) })
  const uri = { pause: 'pause', resume: 'play', stop: 'stop' }[action]
  if (action === 'seek') return request(tv, `ssap://media.controls/${Number(value) < 0 ? 'rewind' : 'fastForward'}`)
  if (!uri) throw new Error(`Unknown action ${action}`)
  return request(tv, `ssap://media.controls/${uri}`)
}
