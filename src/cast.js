import ChromecastAPI from 'chromecast-api'
import mdns from 'multicast-dns'
import dns from 'node:dns/promises'
import net from 'node:net'

const client = new ChromecastAPI()
client.on('device', (d) => console.log(`[cast] found "${d.friendlyName}" at ${d.host}`))

let active = null

// Cast devices advertise a "<uuid>.local" host, which Windows can't resolve without Bonjour,
// so keep our own table of the mDNS A records they announce.
const addresses = new Map()
const resolver = mdns()
resolver.on('response', (r) => {
  for (const a of [...r.answers, ...r.additionals]) {
    if (a.type === 'A') addresses.set(a.name.toLowerCase(), a.data)
  }
})
resolver.on('error', (err) => console.error('[cast] mdns', err.message))

async function resolveHost (host) {
  if (net.isIP(host)) return host
  const key = host.toLowerCase()
  if (!addresses.has(key)) {
    resolver.query({ questions: [{ name: host, type: 'A' }] })
    for (let i = 0; i < 30 && !addresses.has(key); i++) await new Promise((r) => setTimeout(r, 100))
  }
  if (addresses.has(key)) return addresses.get(key)
  try {
    return (await dns.lookup(host, { family: 4 })).address
  } catch {
    throw new Error(`Couldn't find the TV's IP address (${host})`)
  }
}

// chromecast-api crashes reusing a client whose connection failed.
function resetClient (device) {
  try { device.client?.close() } catch {}
  device.client = null
}

export function listDevices () {
  return client.devices.map((d) => ({ name: d.friendlyName, host: d.host }))
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function findDevice (name) {
  const devices = client.devices
  if (!devices.length) return null
  if (!name) return devices[0]
  const n = norm(name.replace(/\b(tv|the)\b/gi, ''))
  return devices.find((d) => norm(d.friendlyName) === norm(name)) ||
    devices.find((d) => norm(d.friendlyName).includes(n) || n.includes(norm(d.friendlyName))) ||
    null
}

export async function waitForDevice (name, timeoutMs = 8000) {
  const start = Date.now()
  client.update()
  while (Date.now() - start < timeoutMs) {
    const d = findDevice(name)
    if (d) return d
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

export async function play (device, url, title) {
  device.host = await resolveHost(device.host)
  resetClient(device)
  active = device
  return new Promise((resolve, reject) => {
    // Default Media Receiver plays H.264 MKVs when told they are video/mp4.
    device.play({ url, contentType: 'video/mp4', cover: { title } }, (err) => {
      if (!err) return resolve()
      resetClient(device)
      active = null
      reject(err)
    })
  })
}

export function stopCast () {
  if (!active) return Promise.resolve()
  const d = active
  active = null
  return new Promise((resolve) => d.stop(() => resolve()))
}

export function control (action, value) {
  if (!active) return Promise.reject(new Error('Nothing is casting'))
  const fn = { pause: 'pause', resume: 'resume', seek: 'seek', volume: 'setVolume' }[action]
  if (!fn) return Promise.reject(new Error(`Unknown action ${action}`))
  return new Promise((resolve, reject) => {
    const cb = (err) => (err ? reject(err) : resolve())
    value === undefined ? active[fn](cb) : active[fn](Number(value), cb)
  })
}
