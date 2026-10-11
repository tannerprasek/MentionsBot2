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
