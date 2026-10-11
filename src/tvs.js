// One list of every TV CastBot can drive (Chromecast / Google Cast, Roku, LG webOS),
// with name matching, playback, app launching and remote control routed to the right protocol.
import path from 'node:path'
import { config, saveDeviceKey } from './config.js'
import { bestTv } from './tvmatch.js'
import { castDevices, refreshCast, resolveHost, play as castPlay, stopCast, control as castControl } from './cast.js'
import { rokuDevices, rokuPlay, rokuOpenApp, rokuControl } from './roku.js'
import { lgDevices, lgPlay, lgOpenApp, lgControl } from './lg.js'
import { hasRenderer, dlnaPlay, dlnaControl } from './dlna.js'
import { isSamsung, openApp as samsungOpenApp } from './samsung.js'
import { searchSsdp } from './ssdp.js'

const lgKeys = {
  get: (ip) => config.lgKeys[ip],
  set: (ip, key) => saveDeviceKey('lgKeys', ip, key)
}

// Each TV appears once. A TV reachable both natively (Roku/LG) and over Google Cast keeps both:
// torrents play over Cast, apps open over the native protocol.
export function listDevices () {
  const natives = [
    ...lgDevices().map((d) => ({ ...d, kind: 'lg' })),
    ...rokuDevices().map((d) => ({ ...d, kind: 'roku' }))
  ]
  const casts = castDevices()
  const out = natives.map((n) => {
    const c = casts.find((x) => x.ip && x.ip === n.ip)
    return { name: c ? c.friendlyName : n.name, names: c ? [c.friendlyName, n.name] : [n.name], kind: n.kind, ip: n.ip, ref: c }
  })
  for (const c of casts) {
    if (!out.some((d) => d.ref === c)) out.push({ name: c.friendlyName, names: [c.friendlyName], kind: 'cast', host: c.host, ip: c.ip, ref: c })
  }
  return out
}

export function findDevice (name) {
  const devices = listDevices()
  if (!devices.length) return null
  if (!name) return devices[0]
  const flat = devices.flatMap((d) => d.names.map((n) => ({ n, d })))
  const i = bestTv(name, flat.map((x) => x.n))
  return i === -1 ? null : flat[i].d
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Closest name match, else the default TV, else any TV. Waits the full timeout only while
// nothing has been discovered at all.
export async function pickDevice (requested, fallback, timeoutMs = 8000) {
  const start = Date.now()
  refreshCast()
  searchSsdp()
  let sawDevices = 0
  while (Date.now() - start < timeoutMs) {
    const d = findDevice(requested)
    if (d) return { device: d, exact: true }
    if (listDevices().length && !sawDevices) sawDevices = Date.now()
    if (sawDevices && Date.now() - sawDevices > 2000) break
    await sleep(300)
  }
  const all = listDevices()
  if (!all.length) return { device: null }
  const d = (fallback && fallback !== requested && findDevice(fallback)) || all[0]
  return { device: d, exact: false }
}

export const deviceIp = async (d) => d.ip || resolveHost(d.host)

let active = null // the device currently playing a CastBot stream

const mimeOf = (file) => (/\.mkv$/i.test(file) ? 'video/x-matroska' : /\.webm$/i.test(file) ? 'video/webm' : 'video/mp4')
const formatOf = (file) => path.extname(file).slice(1).toLowerCase() || 'mp4'

export async function playOn (device, url, title, fileName) {
  await stopPlayback()
  const ip = await deviceIp(device)
  if (device.ref) {
    try {
      await castPlay(device.ref, url, title)
      active = { ...device, ip, via: 'cast' }
      return
    } catch (err) {
      if (device.kind === 'cast') throw err
      console.error(`[tv] Cast failed on ${device.name} (${err.message}); using ${device.kind} instead`)
    }
  }
  // Native players get the file's real content type (the ?cast=1 flag forces video/mp4).
  const nativeUrl = url.replace(/\?cast=1$/, '')
  if (device.kind === 'roku') {
    await rokuPlay(ip, nativeUrl, title, formatOf(fileName))
  } else if (hasRenderer(ip)) {
    await dlnaPlay(ip, nativeUrl, title, mimeOf(fileName))
  } else {
    await lgPlay(ip, nativeUrl, title, mimeOf(fileName), lgKeys)
  }
  active = { ...device, ip, via: device.kind }
}

// Opens a streaming service's app on the TV. Throws when this TV can't be told to.
export async function openAppOn (device, service, url, isSeries) {
  const ip = await deviceIp(device)
  if (device.kind === 'roku') return rokuOpenApp(ip, service, url, isSeries)
  if (device.kind === 'lg') return lgOpenApp(ip, service, url, lgKeys)
  if (await isSamsung(ip)) {
    return samsungOpenApp(ip, service, url, { token: config.samsungTokens[ip], onToken: (t) => saveDeviceKey('samsungTokens', ip, t) })
  }
  throw new Error(`CastBot can't open apps on ${device.name}`)
}

export async function canOpenApps (device) {
  if (device.kind !== 'cast') return true
  const ip = await deviceIp(device).catch(() => null)
  return Boolean(ip && await isSamsung(ip))
}

export async function stopPlayback () {
  const a = active
  active = null
  if (!a) return
  if (a.via === 'cast') return stopCast()
  await control(a, 'stop').catch(() => {})
}

function control (a, action, value) {
  if (a.via === 'cast') return castControl(action, value)
  if (a.kind === 'roku') return rokuControl(a.ip, action, value)
  if (hasRenderer(a.ip)) return dlnaControl(a.ip, action, value)
  return lgControl(a.ip, action, value, lgKeys)
}

export function controlActive (action, value) {
  if (!active) return Promise.reject(new Error('Nothing is playing'))
  return control(active, action, value)
}
