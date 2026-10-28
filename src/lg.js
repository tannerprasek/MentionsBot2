// LG webOS TVs: discovery via SSDP, playback/remote control over LG's SSAP API (lgtv2).
import LGTV from 'lgtv2'
import { XMLParser } from 'fast-xml-parser'
import net from 'node:net'
import { onSsdp, probeSsdp } from './ssdp.js'
import { config } from './config.js'

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

const portOpen = (ip, port, ms = 1200) => new Promise((resolve) => {
  const sock = net.connect({ host: ip, port })
  const done = (ok) => { sock.destroy(); resolve(ok) }
  sock.setTimeout(ms, () => done(false))
  sock.once('connect', () => done(true))
  sock.once('error', () => done(false))
})

// Asks one address directly for its LG/DLNA description. True when it turns out to be an LG.
export async function probeLg (ip) {
  if (devices.has(ip) && !devices.get(ip).pending) return true
  await probeSsdp(ip, 2500)
  await new Promise((r) => setTimeout(r, 600)) // the description is fetched after the answer arrives
  return devices.has(ip) && !devices.get(ip).pending
}

// For networks that drop broadcast searches: find webOS TVs by their remote-control port
// (3001, or 3000 on older sets) across the home network, then ask each one directly.
let scanning = false
export async function scanForLgs () {
  const m = config.publicHost.match(/^(\d+\.\d+\.\d+)\.\d+$/)
  if (!m || scanning) return
  scanning = true
  try {
    const hosts = Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`).filter((h) => h !== config.publicHost && !devices.has(h))
    for (let i = 0; i < hosts.length; i += 32) {
      await Promise.all(hosts.slice(i, i + 32).map(async (h) => {
        if ((await portOpen(h, 3001)) || (await portOpen(h, 3000))) await probeLg(h)
      }))
    }
  } finally {
    scanning = false
  }
}

// The first connection shows a pairing prompt on the TV; the key it returns is saved via saveKey.
function connect (ip, clientKey, saveKey) {
  if (connections.has(ip)) return connections.get(ip)
  if (!clientKey) console.log(`[lg] pairing with ${ip}: press Allow on the TV`)
  const p = new Promise((resolve, reject) => {
    const tv = LGTV({ host: ip, clientKey: clientKey || undefined, saveKey: (key, cb) => { saveKey(key); cb?.() }, reconnect: 0, timeout: 20_000 })
    const timer = setTimeout(() => { tv.disconnect(); reject(new Error('The LG TV did not respond. If it showed a pairing prompt, accept it and try again.')) }, 60_000)
    tv.on('connect', () => { clearTimeout(timer); resolve(tv) })
    tv.on('error', (err) => {
      clearTimeout(timer)
      tv.disconnect()
      if (/reject/i.test(err.message)) {
        return reject(new Error('The LG pairing prompt was declined or timed out. Try again and press Allow on the TV within 30 seconds. No prompt? On the LG: Settings → General → Devices → External Devices → LG Connect Apps → On.'))
      }
      reject(err)
    })
    tv.on('close', () => connections.delete(ip))
  })
  p.catch(() => connections.delete(ip))
  connections.set(ip, p)
  return p
}

const request = (tv, uri, payload) => new Promise((resolve, reject) => tv.request(uri, payload, (err, res) => (err ? reject(err) : resolve(res))))

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
