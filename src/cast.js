import ChromecastAPI from 'chromecast-api'
import castv2 from 'castv2-client'
import mdns from 'multicast-dns'
import dns from 'node:dns/promises'
import net from 'node:net'

const client = new ChromecastAPI()
client.on('device', (d) => {
  console.log(`[cast] found "${d.friendlyName}" at ${d.host}`)
  // The IP lets a Cast-enabled LG/Roku/Samsung be merged with its native entry.
  resolveHost(d.host).then((ip) => { d.ip = ip }).catch(() => {})
})


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
const finishedHandlers = []
export const onCastFinished = (fn) => finishedHandlers.push(fn)

function closeSession () {
  const s = session
  session = null
  if (!s) return
  try { s.client.close() } catch {}
}

const call = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))

const mediaFor = (url, title, contentType) => ({
  contentId: url,
  // Default Media Receiver plays H.264 MKVs when told they are video/mp4; streams say what they are.
  contentType: contentType === 'application/x-mpegURL' || contentType === 'application/dash+xml' ? contentType : 'video/mp4',
  streamType: 'BUFFERED',
  metadata: { type: 0, metadataType: 0, title }
})

export async function play (device, url, title, startTime = 0, contentType) {
  // Same TV, player already open (e.g. the next episode): just load the new video into it,
  // so there's no reconnect or receiver splash between episodes.
  if (session?.device === device) {
    const { player } = session
    try {
      const st = await Promise.race([
        call((cb) => player.load(mediaFor(url, title, contentType), { autoplay: true, currentTime: startTime }, cb)),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 20_000))
      ])
      if (session?.player === player) session.duration = st?.media?.duration
      return
    } catch (err) {
      console.log(`[cast] reusing the open player failed (${err.message}); reconnecting`)
    }
  }
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
    player.on('status', (st) => {
      if (st?.playerState === 'IDLE' && st.idleReason === 'FINISHED' && session?.player === player) {
        for (const fn of finishedHandlers) fn()
      }
    })
    const st = await Promise.race([call((cb) => player.load(mediaFor(url, title, contentType), { autoplay: true, currentTime: startTime }, cb)), failed, timeout(60_000, 'loading the video')])
    if (session?.player === player) session.duration = st?.media?.duration
  } catch (err) {
    if (session?.client === client) session = null
    try { client.close() } catch {}
    throw err
  }
}

// { position, duration, state } of what's casting, in seconds; null when nothing is.
export async function castProgress () {
  if (!session) return null
  const { player } = session
  const st = await Promise.race([call((cb) => player.getStatus(cb)), new Promise((resolve) => setTimeout(() => resolve(undefined), 5000))])
  if (st === undefined) return null
  if (st?.media?.duration) session.duration = st.media.duration
  return { position: st?.currentTime || 0, duration: session.duration || 0, state: (st?.playerState || 'IDLE').toLowerCase() }
}

export async function stopCast () {
  if (!session) return
  const { client, player } = session
  // Don't hang if the TV never answers the stop request.
  await Promise.race([call((cb) => client.stop(player, cb)), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => {})
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
