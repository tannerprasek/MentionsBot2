// One list of every TV CastBot can drive (Chromecast / Google Cast, Roku, LG webOS),
// with name matching, playback and remote control routed to the right protocol.
import path from 'node:path'
import { config, saveDeviceKey } from './config.js'
import { bestTv, tvScore } from './tvmatch.js'
import { castDevices, refreshCast, onCastFinished, resolveHost, play as castPlay, castProgress, stopCast, control as castControl } from './cast.js'
import { rokuDevices, rokuPlay, rokuProgress, rokuControl, scanForRokus } from './roku.js'
import { lgDevices, lgPlay, lgControl } from './lg.js'
import { hasRenderer, dlnaPlay, dlnaProgress, dlnaControl } from './dlna.js'
import { isSamsung, exitArtMode } from './samsung.js'
import { searchSsdp } from './ssdp.js'

// Look for TVs every 30 seconds, so one that was just switched on shows up without a restart.
export function refreshTvs () {
  refreshCast()
  searchSsdp()
  if (!rokuDevices().length) scanForRokus()
}
setInterval(refreshTvs, 30_000).unref()

export const onPlaybackFinished = (fn) => onCastFinished(() => { active = null; fn() })

const lgKeys = {
  get: (ip) => config.lgKeys[ip],
  set: (ip, key) => saveDeviceKey('lgKeys', ip, key)
}

// Each TV appears once. A TV reachable both natively (Roku/LG) and over Google Cast keeps both:
// torrents play over Cast, falling back to the native player.
export function listDevices () {
  const natives = [
    ...lgDevices().map((d) => ({ ...d, kind: 'lg' })),
    ...rokuDevices().map((d) => ({ ...d, kind: 'roku' }))
  ]
  const casts = castDevices()
  // Same IP alone isn't enough (a wrong address lookup would merge two different TVs);
  // the names must look alike too, e.g. "[LG] webOS TV OLED77" and "LG OLED77".
  const out = natives.map((n) => {
    const c = casts.find((x) => x.ip && x.ip === n.ip && sameTv(x.friendlyName, n.name, n.kind))
    return { name: c ? c.friendlyName : n.name, names: c ? [c.friendlyName, n.name] : [n.name], kind: n.kind, ip: n.ip, ref: c }
  })
  for (const c of casts) {
    if (!out.some((d) => d.ref === c)) out.push({ name: c.friendlyName, names: [c.friendlyName], kind: 'cast', host: c.host, ip: c.ip, ref: c })
  }
  return out
}

function sameTv (castName, nativeName, kind) {
  if (tvScore(castName, nativeName) >= 0.6 || tvScore(nativeName, castName) >= 0.6) return true
  const brand = kind === 'lg' ? /\blg\b|webos/i : /roku|tcl|hisense/i
  return brand.test(castName)
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
const formatOf = (file) => { const e = path.extname(file).slice(1).toLowerCase(); return e === 'm3u8' ? 'hls' : e === 'mpd' ? 'dash' : e || 'mp4' }

// Chromecast and DLNA (LG) can start partway in; Roku's "Play on Roku" can't.
export async function canResume (device) {
  if (device.ref) return true
  return device.kind === 'lg' && hasRenderer(await deviceIp(device))
}

export async function playOn (device, url, title, fileName, startAt = 0, mime) {
  // Moving on to the next video on the same Chromecast keeps its player open (seamless);
  // anything else stops what was playing first.
  const sameCast = active?.via === 'cast' && device.ref && active.ref === device.ref
  if (!sameCast) await stopPlayback()
  const ip = await deviceIp(device)
  console.log(`[tv] playing on "${device.name}" (${device.kind}${device.ref ? ' + cast' : ''}, ${ip})`)
  // An LG's Google Cast can't open a media player (the launch fails with SYSTEM_ERROR), so an LG
  // that offers DLNA is played that way and Cast is only tried when there's no alternative.
  const lgCast = device.kind === 'cast' && /\blg\b|webos/i.test(device.name)
  if (lgCast && !hasRenderer(ip)) {
    // The TV's DLNA player may simply not have answered the network search yet.
    searchSsdp()
    for (let i = 0; i < 12 && !hasRenderer(ip); i++) await sleep(500)
  }
  let castError = null
  if (device.ref && !(lgCast && hasRenderer(ip))) {
    if (device.kind === 'cast' && await isSamsung(ip)) {
      await exitArtMode(ip, { token: config.samsungTokens[ip], onToken: (t) => saveDeviceKey('samsungTokens', ip, t) }).catch(() => {})
    }
    try {
      await castPlay(device.ref, url, title, startAt, mime)
      active = { ...device, ip, via: 'cast' }
      return
    } catch (err) {
      castError = err
      console.error(`[tv] Cast failed on ${device.name} (${err.message})${hasRenderer(ip) ? '; using DLNA instead' : device.kind === 'cast' ? '' : `; using ${device.kind} instead`}`)
    }
  }
  // A plain Chromecast has no other way to play.
  if (castError && device.kind === 'cast' && !hasRenderer(ip)) {
    throw lgCast
      ? new Error("The LG's Chromecast can't play videos and its other player (DLNA) wasn't found. Make sure the LG is fully on (not standby) and try again in a few seconds.")
      : castError
  }
  // Native players get the file's real content type (the ?cast=1 flag forces video/mp4).
  const nativeUrl = url.replace(/\?cast=1$/, '')
  if (device.kind === 'roku') {
    await rokuPlay(ip, nativeUrl, title, formatOf(fileName))
  } else if (hasRenderer(ip)) {
    await dlnaPlay(ip, nativeUrl, title, mime || mimeOf(fileName), startAt)
  } else {
    await lgPlay(ip, nativeUrl, title, mime || mimeOf(fileName), lgKeys)
  }
  active = { ...device, ip, via: device.kind === 'cast' ? 'dlna' : device.kind }
}

// Opens a streaming service's app on the TV. Throws when this TV can't be told to.
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

// Where the TV is in the video: { position, duration, state } in seconds, or null.
export async function progress () {
  const a = active
  if (!a) return null
  if (a.via === 'cast') return castProgress()
  if (a.kind === 'roku') return rokuProgress(a.ip)
  if (hasRenderer(a.ip)) return dlnaProgress(a.ip)
  return null
}

export function controlActive (action, value) {
  if (!active) return Promise.reject(new Error('Nothing is playing'))
  return control(active, action, value)
}
