import ChromecastAPI from 'chromecast-api'

const client = new ChromecastAPI()
client.on('device', (d) => console.log(`[cast] found "${d.friendlyName}" at ${d.host}`))

let active = null

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

export function play (device, url, title) {
  active = device
  return new Promise((resolve, reject) => {
    // Default Media Receiver plays H.264 MKVs when told they are video/mp4.
    device.play({ url, contentType: 'video/mp4', cover: { title } }, (err) => (err ? reject(err) : resolve()))
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
