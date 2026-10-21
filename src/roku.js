// Roku TVs and sticks, controlled through Roku's External Control Protocol (port 8060).
import { onSsdp } from './ssdp.js'
import { config } from './config.js'

const devices = new Map() // ip -> { name, ip }

// Asks a host for its Roku device info; adds it to the list when it answers like a Roku.
async function probe (host, timeoutMs = 4000) {
  if (devices.has(host)) return
  devices.set(host, { name: 'Roku', ip: host, pending: true })
  try {
    const res = await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(timeoutMs) })
    const xml = await res.text()
    if (!xml.includes('<device-info')) throw new Error('not a Roku')
    const tag = (t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim()
    const name = tag('user-device-name') || tag('friendly-device-name') || tag('default-device-name') || tag('model-name') || 'Roku'
    devices.set(host, { name, ip: host })
    console.log(`[roku] found "${name}" at ${host}`)
  } catch {
    devices.delete(host)
  }
}

onSsdp(({ st, usn, location, ip }) => {
  if (!(st.includes('roku:ecp') || usn.includes('roku:ecp'))) return
  probe(location ? new URL(location).hostname : ip)
})

// Backup for routers that block discovery broadcasts: try port 8060 on every address in the
// home network (x.x.x.1-254), a few at a time, when no Roku has turned up.
let scanning = false
export async function scanForRokus () {
  const m = config.publicHost.match(/^(\d+\.\d+\.\d+)\.\d+$/)
  if (!m || scanning) return
  scanning = true
  const hosts = Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`).filter((h) => h !== config.publicHost && !devices.has(h))
  try {
    for (let i = 0; i < hosts.length; i += 32) await Promise.all(hosts.slice(i, i + 32).map((h) => probe(h, 1500)))
  } finally {
    scanning = false
  }
}
setTimeout(() => { if (!rokuDevices().length) scanForRokus() }, 15_000).unref()
setInterval(() => { if (!rokuDevices().length) scanForRokus() }, 5 * 60_000).unref()

export const rokuDevices = () => [...devices.values()].filter((d) => !d.pending)

async function ecp (ip, path) {
  const res = await fetch(`http://${ip}:8060${path}`, { method: 'POST', signal: AbortSignal.timeout(8000) })
  if (res.status === 403) {
    throw new Error('The Roku blocked CastBot. On the Roku: Settings → System → Advanced system settings → Control by mobile apps → set it to Enabled (Network access: Permissive)')
  }
  if (!res.ok) throw new Error(`Roku replied HTTP ${res.status}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Whether Roku's media player picked the video up (it sometimes opens and quits right away).
async function playerStarted (ip) {
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    const p = await rokuProgress(ip).catch(() => null)
    if (p && ['playing', 'buffering', 'paused'].includes(p.state)) return true
  }
  return false
}

// Plays a URL in Roku's built-in "Play on Roku" channel (app 15985). Roku models differ in which
// form they accept, so each is tried and checked; the error says what to do if none works.
export async function rokuPlay (ip, url, title, format) {
  const q = new URLSearchParams({ t: 'v', u: url, videoName: title, videoFormat: format, k: '(null)' })
  const attempts = [`/launch/15985?${q}`, `/input/15985?${q}`]
  const failures = []
  for (const path of attempts) {
    try {
      await ecp(ip, path)
    } catch (err) {
      if (/blocked CastBot/.test(err.message)) throw err
      failures.push(`${path.split('?')[0]}: ${err.message}`)
      continue
    }
    if (await playerStarted(ip)) {
      console.log(`[roku] playing via ${path.split('?')[0]}`)
      return
    }
    failures.push(`${path.split('?')[0]}: the player didn't start`)
  }
  console.log(`[roku] couldn't play on ${ip}: ${failures.join('; ')}`)
  throw new Error("This Roku won't play links sent to it (its \"Play on Roku\" player is missing or refused). Make sure Settings → System → Advanced system settings → Control by mobile apps is Enabled, then try again.")
}

// { position, duration, state } from Roku's media player, in seconds.
export async function rokuProgress (ip) {
  const xml = await (await fetch(`http://${ip}:8060/query/media-player`, { signal: AbortSignal.timeout(4000) })).text()
  const ms = (tag) => Number(xml.match(new RegExp(`<${tag}>(\\d+) ms</${tag}>`))?.[1] || 0) / 1000
  const state = xml.match(/<player[^>]*state="([^"]+)"/)?.[1] || 'none'
  const map = { play: 'playing', pause: 'paused', buffer: 'buffering', open: 'buffering', startup: 'buffering' }
  return { position: ms('position'), duration: ms('duration'), state: map[state] || 'stopped' }
}

const KEYS = { pause: 'Play', resume: 'Play', stop: 'Home' }

export async function rokuControl (ip, action, value) {
  if (KEYS[action]) return ecp(ip, `/keypress/${KEYS[action]}`)
  if (action === 'seek') {
    // Roku has no exact seek over ECP; Instant Replay jumps back ~10s, Fwd scrubs ahead.
    if (Number(value) < 0) {
      for (let i = 0; i < 3; i++) await ecp(ip, '/keypress/InstantReplay')
      return
    }
    await ecp(ip, '/keypress/Fwd')
    await new Promise((r) => setTimeout(r, 1500))
    return ecp(ip, '/keypress/Play')
  }
  if (action === 'volume') throw new Error('Use the Roku remote for volume')
  throw new Error(`Unknown action ${action}`)
}
