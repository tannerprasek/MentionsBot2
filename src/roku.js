// Roku TVs and sticks, controlled through Roku's External Control Protocol (port 8060).
import { onSsdp } from './ssdp.js'
import { config } from './config.js'
import { setMediaItem } from './mediaserver.js'

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

const getText = async (ip, path) => (await fetch(`http://${ip}:8060${path}`, { signal: AbortSignal.timeout(4000) })).text()
const attr = (xml, tag, name) => xml.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`))?.[1]

// Installed channels as [{ id, name }].
async function installedApps (ip) {
  const xml = await getText(ip, '/query/apps')
  return [...xml.matchAll(/<app id="([^"]+)"[^>]*>([^<]*)<\/app>/g)].map((m) => ({ id: m[1], name: m[2] }))
}

// Waits to see Roku's player take the video: playing/buffering, or the Play on Roku /
// Media Player channel in front. Logs what the Roku reports, to show why when it doesn't.
async function playerStarted (ip, label) {
  let last = ''
  for (let i = 0; i < 10; i++) {
    await sleep(1500)
    const [mp, active] = await Promise.all([getText(ip, '/query/media-player').catch(() => ''), getText(ip, '/query/active-app').catch(() => '')])
    const state = attr(mp, 'player', 'state') || 'none'
    const app = active.match(/<app id="([^"]*)"[^>]*>([^<]*)</)
    last = `player ${state}, active app ${app ? `${app[2]} (${app[1]})` : '?'}${attr(mp, 'player', 'error') === 'true' ? ', error flagged' : ''}`
    if (['play', 'pause', 'buffer', 'open', 'startup'].includes(state)) return { ok: true, last }
    if (app && ['15985', '2213'].includes(app[1]) && i >= 4) return { ok: true, last } // channel stayed open
  }
  console.log(`[roku] ${label}: ${last}`)
  return { ok: false, last }
}

// Roku Media Player (channel 2213) lists DLNA servers on the network. CastBot offers the video as
// "CastBot" there, opens the player, and presses the keys in ROKU_KEYS (comma-separated, e.g.
// "Down,Select,Select") to reach it; with no keys set you pick CastBot → the video once by hand.
async function viaMediaPlayer (ip, url, title, format) {
  const mime = format === 'mkv' ? 'video/x-matroska' : format === 'webm' ? 'video/webm' : 'video/mp4'
  setMediaItem({ title, url, mime, size: 0 })
  console.log('[roku] no "Play on Roku"; offering the video on the CastBot media server and opening Roku Media Player')
  await ecp(ip, '/launch/2213')
  for (const key of String(config.rokuKeys || '').split(',').map((k) => k.trim()).filter(Boolean)) {
    await sleep(2500)
    await ecp(ip, `/keypress/${key}`).catch((err) => console.log(`[roku] key ${key}: ${err.message}`))
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1500)
    const mp = await getText(ip, '/query/media-player').catch(() => '')
    if (['play', 'pause', 'buffer', 'open', 'startup'].includes(attr(mp, 'player', 'state') || '')) {
      console.log('[roku] playing via Roku Media Player')
      return
    }
  }
  setMediaItem(null)
  throw new Error(`Roku Media Player is open on the TV but nothing was picked. Choose "CastBot" in its list, then "${title}".`)
}

// Plays a URL in Roku's built-in "Play on Roku" channel (app 15985). Roku models differ in which
// form they accept, so each is tried and checked; the error says what was found if none works.
export async function rokuPlay (ip, url, title, format) {
  const apps = await installedApps(ip).catch(() => [])
  const hasPlayer = apps.some((a) => a.id === '15985')
  const media = apps.filter((a) => a.id === '2213' || /play on roku|media player/i.test(a.name))
  console.log(`[roku] ${apps.length} channels installed; Play on Roku: ${hasPlayer ? 'yes' : 'NO'}; media players: ${media.map((a) => `${a.name} (${a.id})`).join(', ') || 'none'}`)

  // No "Play on Roku": use Roku Media Player, which plays from CastBot's built-in media server.
  if (!hasPlayer && apps.some((a) => a.id === '2213')) return viaMediaPlayer(ip, url, title, format)

  const q = new URLSearchParams({ t: 'v', u: url, videoName: title, videoFormat: format, k: '(null)' })
  const attempts = [`/launch/15985?${q}`, `/input/15985?${q}`]
  const failures = []
  for (const path of attempts) {
    const name = path.split('?')[0]
    try {
      await ecp(ip, path)
    } catch (err) {
      if (/blocked CastBot/.test(err.message)) throw err
      failures.push(`${name}: ${err.message}`)
      console.log(`[roku] ${name}: ${err.message}`)
      continue
    }
    const r = await playerStarted(ip, name)
    if (r.ok) {
      console.log(`[roku] playing via ${name} (${r.last})`)
      return
    }
    failures.push(`${name}: ${r.last}`)
  }
  console.log(`[roku] couldn't play on ${ip}: ${failures.join('; ')}`)
  throw new Error(hasPlayer || !apps.length
    ? `This Roku accepted the video but its player didn't start (${failures.at(-1)}). The TV may not support this file or Play on Roku.`
    : "This Roku doesn't have the \"Play on Roku\" channel, so CastBot can't send videos to it. Install a media player channel on the Roku (e.g. \"Roku Media Player\" or Plex) or play on another TV.")
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
// (stop also withdraws the video from the media server)

export async function rokuControl (ip, action, value) {
  if (action === 'stop') setMediaItem(null)
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
