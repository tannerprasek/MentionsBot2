// Roku TVs and sticks, controlled through Roku's External Control Protocol (port 8060).
import { onSsdp } from './ssdp.js'

const devices = new Map() // ip -> { name, ip }

onSsdp(async ({ st, usn, location, ip }) => {
  if (!(st.includes('roku:ecp') || usn.includes('roku:ecp')) || devices.has(ip)) return
  const host = location ? new URL(location).hostname : ip
  devices.set(host, { name: 'Roku', ip: host, pending: true })
  try {
    const xml = await (await fetch(`http://${host}:8060/query/device-info`, { signal: AbortSignal.timeout(4000) })).text()
    const tag = (t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim()
    const name = tag('user-device-name') || tag('friendly-device-name') || tag('default-device-name') || tag('model-name') || 'Roku'
    devices.set(host, { name, ip: host })
    console.log(`[roku] found "${name}" at ${host}`)
  } catch {
    devices.delete(host)
  }
})

export const rokuDevices = () => [...devices.values()].filter((d) => !d.pending)

async function ecp (ip, path) {
  const res = await fetch(`http://${ip}:8060${path}`, { method: 'POST', signal: AbortSignal.timeout(8000) })
  if (res.status === 403) {
    throw new Error('The Roku blocked CastBot. On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive')
  }
  if (!res.ok) throw new Error(`Roku replied HTTP ${res.status}`)
}

// Plays a URL in Roku's built-in "Play on Roku" channel.
export function rokuPlay (ip, url, title, format) {
  const q = new URLSearchParams({ t: 'v', u: url, videoName: title, videoFormat: format, k: '(null)' })
  return ecp(ip, `/input/15985?${q}`)
}

const APPS = { netflix: '12', disneyplus: '291097', appletvplus: '551012' }

function deepLink (service, url, isSeries) {
  const mediaType = isSeries ? 'series' : 'movie'
  if (service === 'netflix') {
    const id = url.match(/title\/(\d+)/)?.[1]
    return id ? { contentId: id, mediaType } : {}
  }
  if (service === 'disneyplus') {
    const id = url.match(/entity-([0-9a-f-]+)/)?.[1]
    return id ? { contentId: `entity-${id}`, mediaType } : {}
  }
  if (service === 'appletvplus') {
    const id = url.match(/(umc\.cmc\.[a-z0-9]+)/)?.[1]
    return id ? { contentId: id, mediaType } : {}
  }
  return {}
}

export async function rokuOpenApp (ip, service, url, isSeries, profile) {
  const app = APPS[service]
  if (!app) throw new Error(`No Roku app known for ${service}`)
  await ecp(ip, `/launch/${app}?${new URLSearchParams(deepLink(service, url, isSeries))}`)
  // Netflix documents Roku content IDs; the others only open the app.
  const result = { deep: service === 'netflix' }
  if (!profile) return result
  // Same profile-screen navigation as on Samsung: first profile, then right, then OK.
  await new Promise((r) => setTimeout(r, 8000))
  for (let i = 0; i < 6; i++) await ecp(ip, '/keypress/Left')
  for (let i = 1; i < profile; i++) await ecp(ip, '/keypress/Right')
  await ecp(ip, '/keypress/Select')
  return result
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
