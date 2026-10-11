import ChromecastAPI from 'chromecast-api'
import castv2 from 'castv2-client'
import mdns from 'multicast-dns'
import dns from 'node:dns/promises'
import net from 'node:net'

const client = new ChromecastAPI()
client.on('device', (d) => console.log(`[cast] found "${d.friendlyName}" at ${d.host}`))


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

export async function resolveHost (host) {
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

export const castDevices = () => client.devices
export const refreshCast = () => client.update()

// chromecast-api is only used for discovery. Its connect/close path crashes on a failed
// connection and hides the real error, so the cast session is driven with castv2-client here.
let session = null // { client, player }

function closeSession () {
  const s = session
  session = null
  if (!s) return
  try { s.client.close() } catch {}
}

const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))

export async function play (device, url, title) {
  closeSession()
  const host = await resolveHost(device.host)
  const client = new castv2.Client()
  const failed = new Promise((_resolve, reject) => client.on('error', (err) => {
    console.error(`[cast] ${device.friendlyName}: ${err.message}`)
    if (session?.client === client) session = null
    try { client.close() } catch {}
    reject(err)
  }))
  failed.catch(() => {})

  const timeout = (ms, what) => new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`TV didn't respond while ${what} (${host})`)), ms))

  try {
    await Promise.race([
      new Promise((resolve) => client.connect({ host, port: 8009 }, resolve)),
      failed, timeout(10_000, 'connecting')
    ])
    const player = await Promise.race([call((cb) => client.launch(castv2.DefaultMediaReceiver, cb)), failed, timeout(20_000, 'opening the player')])
    session = { client, player, device }
    // Default Media Receiver plays H.264 MKVs when told they are video/mp4.
    const media = {
      contentId: url,
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      metadata: { type: 0, metadataType: 0, title }
    }
    await Promise.race([call((cb) => player.load(media, { autoplay: true }, cb)), failed, timeout(60_000, 'loading the video')])
  } catch (err) {
    if (session?.client === client) session = null
    try { client.close() } catch {}
    throw err
  }
}

export async function stopCast () {
  if (!session) return
  const { client, player } = session
  await call((cb) => client.stop(player, cb)).catch(() => {})
  closeSession()
}

export async function control (action, value) {
  if (!session) throw new Error('Nothing is casting')
  const { client, player } = session
  switch (action) {
    case 'pause': return call((cb) => player.pause(cb))
    case 'resume': return call((cb) => player.play(cb))
    case 'seek': {
      const status = await call((cb) => player.getStatus(cb))
      return call((cb) => player.seek(Math.max(0, (status?.currentTime || 0) + Number(value)), cb))
    }
    case 'volume': return call((cb) => client.setVolume({ level: Math.min(1, Math.max(0, Number(value))) }, cb))
    default: throw new Error(`Unknown action ${action}`)
  }
}
