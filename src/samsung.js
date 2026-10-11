// Opens streaming apps on Samsung (Tizen) TVs through the TV's local remote-control API.
// Launching is tried several ways and checked, because Samsung models differ in what they accept.
import WebSocket from 'ws'
import net from 'node:net'

// Store IDs first, then the Tizen package IDs some firmware uses instead.
const APPS = {
  netflix: ['3201907018807', '11101200001', 'RN1MCdNq8t.Netflix'],
  disneyplus: ['3201901017640', 'MCmYXNxgcu.DisneyPlus'],
  appletvplus: ['3201807016597']
}

const log = (...a) => console.log('[samsung]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const portOpen = (ip, port) => new Promise((resolve) => {
  const sock = net.connect({ host: ip, port, timeout: 2500 })
  const done = (ok) => { sock.destroy(); resolve(ok) }
  sock.on('connect', () => done(true))
  sock.on('timeout', () => done(false))
  sock.on('error', () => done(false))
})

// Samsung TVs describe themselves on :8001; some newer models only expose the :8002 remote socket.
export async function isSamsung (ip) {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(2500) })
    const info = await res.json()
    if (/samsung/i.test(JSON.stringify(info.device || info))) return true
  } catch {}
  return portOpen(ip, 8002)
}

// null = the TV won't say (some models hide this), otherwise { installed, running }.
async function appState (ip, appId) {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/applications/${appId}`, { signal: AbortSignal.timeout(3000) })
    if (res.status === 404) return { installed: false, running: false }
    if (!res.ok) return null
    const j = await res.json()
    return { installed: true, running: Boolean(j.running || j.visible) }
  } catch {
    return null
  }
}

function deepLink (service, url) {
  if (service === 'netflix') {
    const id = url.match(/title\/(\d+)/)?.[1]
    return id ? `m=${id}&source_type=4` : ''
  }
  return url
}

// Opens the remote-control socket; the first time the TV shows an "Allow" prompt and returns a token.
function connect (ip, token, onToken) {
  const name = Buffer.from('CastBot').toString('base64')
  const url = `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${name}${token ? `&token=${token}` : ''}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('The TV did not respond. If it showed an "Allow" prompt, accept it with the remote and try again.'))
    }, 30_000)
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.event === 'ms.channel.unauthorized') {
        clearTimeout(timer); ws.close()
        reject(new Error('The TV refused CastBot. On the TV, allow CastBot under Settings → General → External Device Manager → Device Connection Manager → Device List, then try again.'))
      }
      if (msg.event === 'ms.channel.connect') {
        clearTimeout(timer)
        if (msg.data?.token && msg.data.token !== token) onToken?.(msg.data.token)
        resolve(ws)
      }
    })
  })
}

function wsLaunch (ws, appId, actionType, metaTag) {
  const data = { appId, action_type: actionType }
  if (metaTag) data.metaTag = metaTag
  ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data } }))
}

async function restLaunch (ip, appId, metaTag) {
  const res = await fetch(`http://${ip}:8001/api/v2/applications/${appId}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: metaTag || '',
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function waitRunning (ip, appId) {
  for (let i = 0; i < 8; i++) {
    await sleep(1000)
    const s = await appState(ip, appId)
    if (s === null) return null
    if (s.running) return true
  }
  return false
}

export async function openApp (ip, service, url, { token, onToken } = {}) {
  const candidates = APPS[service]
  if (!candidates) throw new Error(`No TV app known for ${service}`)

  // Use the ID this TV recognises; if it won't tell us, try them all.
  const states = await Promise.all(candidates.map((id) => appState(ip, id)))
  let ids = candidates.filter((_, i) => states[i]?.installed)
  if (!ids.length && states.every((s) => s && !s.installed)) throw new Error(`The ${service} app isn't installed on this TV`)
  if (!ids.length) ids = candidates
  log(`opening ${service} on ${ip} (app IDs to try: ${ids.join(', ')})`)

  const ws = await connect(ip, token, onToken)
  try {
    const meta = deepLink(service, url)
    const attempts = []
    for (const id of ids) {
      if (meta) attempts.push([`deep link ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK', meta), id])
      attempts.push([`launch ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK'), id])
      attempts.push([`native launch ${id}`, () => wsLaunch(ws, id, 'NATIVE_LAUNCH'), id])
      attempts.push([`REST launch ${id}`, () => restLaunch(ip, id, meta), id])
    }
    for (const [label, run, id] of attempts) {
      try {
        await run()
      } catch (err) {
        log(`${label}: failed (${err.message})`)
        continue
      }
      const ok = await waitRunning(ip, id)
      if (ok === null) { log(`${label}: sent (this TV doesn't report whether apps are running)`); return }
      if (ok) { log(`${label}: app is running`); return }
      log(`${label}: app didn't open`)
    }
    throw new Error(`The TV didn't open ${service}. If the Frame is in Art Mode, switch it to TV mode and try again.`)
  } finally {
    try { ws.close() } catch {}
  }
}
