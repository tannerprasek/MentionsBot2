// Opens streaming apps on Samsung (Tizen) TVs through the TV's local remote-control API.
// Launching is tried several ways and checked, because Samsung models differ in what they accept.
import WebSocket from 'ws'
import net from 'node:net'

// Names used to find the app in the TV's installed-app list.
const APP_NAMES = { netflix: /netflix/i, disneyplus: /disney/i, appletvplus: /apple ?tv/i }

// Fallback IDs: store IDs first, then the Tizen package IDs some firmware uses instead.
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
    // Long enough to find the remote and press Allow on the first-time prompt.
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('The TV did not respond. If it showed an "Allow" prompt, accept it with the remote and try again.'))
    }, token ? 15_000 : 120_000)
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
        if (msg.data?.token && msg.data.token !== token) {
          log('paired; saving the TV\'s token')
          onToken?.(msg.data.token)
        }
        resolve(ws)
      }
    })
  })
}

// Asks the TV for its installed apps (works on models that hide the REST app endpoints).
function installedApps (ws) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null) }, 5000)
    function onMsg (raw) {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.event !== 'ed.installedApp.get') return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve([].concat(msg.data?.data || []).map((a) => ({ id: a.appId, name: a.name })))
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }))
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
  if (!APPS[service]) throw new Error(`No TV app known for ${service}`)
  log(`opening ${service} on ${ip}${token ? '' : ' (first time: accept the Allow prompt on the TV)'}`)
  const ws = await connect(ip, token, onToken)
  try {
    // Prefer the ID the TV itself reports for the app, then the known IDs.
    const apps = await installedApps(ws)
    if (apps) log(`TV reports ${apps.length} installed apps`)
    const reported = (apps || []).filter((a) => APP_NAMES[service].test(a.name)).map((a) => a.id)
    if (apps && !reported.length) log(`${service} not in the TV's app list: ${apps.map((a) => a.name).join(', ')}`)
    const ids = [...new Set([...reported, ...APPS[service]])]
    log(`app IDs to try: ${ids.join(', ')}`)

    // Opening the app matters most; deep links (only reliable for Netflix) come after.
    const meta = deepLink(service, url)
    const attempts = []
    for (const id of ids) {
      if (service === 'netflix' && meta) attempts.push([`deep link ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK', meta), id])
      attempts.push([`launch ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK'), id])
      attempts.push([`native launch ${id}`, () => wsLaunch(ws, id, 'NATIVE_LAUNCH'), id])
      attempts.push([`REST launch ${id}`, () => restLaunch(ip, id, service === 'netflix' ? meta : ''), id])
    }

    let unverified = 0
    for (const [label, run, id] of attempts) {
      try {
        await run()
      } catch (err) {
        log(`${label}: failed (${err.message})`)
        continue
      }
      const ok = await waitRunning(ip, id)
      if (ok) { log(`${label}: app is running`); return }
      if (ok === null) {
        // This TV won't say whether the app opened; send a few variants, then stop.
        log(`${label}: sent (TV doesn't report running apps)`)
        await sleep(1500)
        if (++unverified >= 3) return
        continue
      }
      log(`${label}: app didn't open`)
    }
    if (unverified) return
    throw new Error(`The TV didn't open ${service}. If the Frame is in Art Mode, switch it to TV mode and try again.`)
  } finally {
    await sleep(500)
    try { ws.close() } catch {}
  }
}
