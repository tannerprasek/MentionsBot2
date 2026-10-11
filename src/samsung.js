// Opens streaming apps on Samsung (Tizen) TVs through the TV's local remote-control API.
// Launching is tried several ways and checked, because Samsung models differ in what they accept.
import WebSocket from 'ws'
import net from 'node:net'
import { dialNetflix } from './dial.js'

// Names used to find the app in the TV's installed-app list.
const APP_NAMES = { netflix: /netflix/i, disneyplus: /disney/i, appletvplus: /apple ?tv/i }

// Fallback IDs: store IDs first, then the Tizen package IDs some firmware uses instead.
const APPS = {
  netflix: ['3201907018807', '11101200001', 'RN1MCdNq8t.Netflix'],
  disneyplus: ['3201901017640', 'MCmYXNxgcu.DisneyPlus'],
  appletvplus: ['3201807016597']
}

const log = (...a) => console.log('[samsung]', ...a)
let latestToken = null // token from the most recent pairing, reused by the art-mode socket
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

// Opens a TV socket (remote control by default); the first time the TV shows an "Allow" prompt and returns a token.
function connect (ip, token, onToken, channel = 'samsung.remote.control') {
  const name = Buffer.from('CastBot').toString('base64')
  const url = `wss://${ip}:8002/api/v2/channels/${channel}?name=${name}${token ? `&token=${token}` : ''}`
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
        if (msg.data?.token) latestToken = msg.data.token
        if (msg.data?.token && msg.data.token !== token) {
          log('paired; saving the TV\'s token')
          onToken?.(msg.data.token)
        }
        // Newer firmware drops commands sent before it announces the channel is ready.
        const ready = setTimeout(() => resolve(ws), 2000)
        ws.once('message', function onReady (r) {
          if (String(r).includes('ms.channel.ready')) { clearTimeout(ready); resolve(ws) } else ws.once('message', onReady)
        })
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

// Plain POST with no body is what Tizen's REST launcher accepts; a body makes some models answer 400.
async function restLaunch (ip, appId) {
  let res = await fetch(`http://${ip}:8001/api/v2/applications/${appId}`, { method: 'POST', signal: AbortSignal.timeout(5000) })
  if (res.status === 400 || res.status === 401) {
    // Older firmware serves app launches under /ws/apps instead.
    res = await fetch(`http://${ip}:8001/ws/apps/${appId}`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => res)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`.trim())
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

// --- The Frame's Art Mode ---

function artRequest (ws, request, extra = {}) {
  const id = Math.random().toString(36).slice(2)
  ws.send(JSON.stringify({
    method: 'ms.channel.emit',
    params: { event: 'art_app_request', to: 'host', data: JSON.stringify({ request, id, ...extra }) }
  }))
}

function artReply (ws, wanted, ms = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); resolve(null) }, ms)
    function onMsg (raw) {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.event !== 'd2d_service_message') return
      let data
      try { data = JSON.parse(msg.data) } catch { return }
      if (data.event !== wanted) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(data)
    }
    ws.on('message', onMsg)
  })
}

const pressKey = (ws, key) => ws.send(JSON.stringify({
  method: 'ms.remote.control',
  params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' }
}))

// Switches a Frame from Art Mode to TV mode. Does nothing on TVs without Art Mode or already in TV mode.
export async function exitArtMode (ip, { token, onToken } = {}) {
  let art
  try {
    art = await connect(ip, token, onToken, 'com.samsung.art-app')
  } catch (err) {
    log(`art mode: not available (${err.message})`)
    return false
  }
  try {
    const status = artReply(art, 'artmode_status')
    artRequest(art, 'get_artmode_status')
    const st = await status
    if (!st) { log('art mode: TV gave no status (not a Frame?)'); return false }
    log(`art mode is ${st.value}`)
    if (st.value !== 'on') return false

    const changed = artReply(art, 'art_mode_changed', 6000)
    artRequest(art, 'set_artmode_status', { value: 'off' })
    if ((await changed)?.status === 'off') { log('art mode: switched to TV mode'); await sleep(2500); return true }

    // Some Frames ignore the request; a short press of Power flips Art Mode to TV mode.
    log('art mode: request ignored, pressing Power')
    const remote = await connect(ip, token, onToken)
    pressKey(remote, 'KEY_POWER')
    await sleep(500)
    remote.close()
    await sleep(3000)
    return true
  } finally {
    try { art.close() } catch {}
  }
}

let queue = Promise.resolve()

// One launch at a time; a second request waits for the first to finish.
export function openApp (...args) {
  const run = queue.then(() => openAppNow(...args))
  queue = run.catch(() => {})
  return run
}

const described = new Set()
async function describeTv (ip) {
  if (described.has(ip)) return
  described.add(ip)
  try {
    const d = (await (await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(2500) })).json()).device || {}
    log(`TV: ${d.modelName || '?'} (${d.name || '?'}), OS ${d.OS || '?'}, firmware ${d.firmwareVersion || '?'}, power ${d.PowerState || '?'}, Frame ${d.FrameTVSupport || '?'}, token auth ${d.TokenAuthSupport || '?'}`)
  } catch {}
}

// Streaming apps open on a "Who's watching?" screen. Press Left to reach the first profile,
// Right to the chosen one, then OK. profile 0 = leave the screen alone.
async function pickProfile (ws, profile) {
  if (!profile) return
  log(`picking profile ${profile}`)
  await sleep(7000) // let the app finish loading
  for (let i = 0; i < 6; i++) { pressKey(ws, 'KEY_LEFT'); await sleep(300) }
  for (let i = 1; i < profile; i++) { pressKey(ws, 'KEY_RIGHT'); await sleep(400) }
  pressKey(ws, 'KEY_ENTER')
  await sleep(500)
}

// Resolves { deep: true } when the app opened straight to the title, { deep: false } when only the app opened.
async function openAppNow (ip, service, url, { token, onToken, profile } = {}) {
  await describeTv(ip)
  if (service === 'netflix') {
    await exitArtMode(ip, { token, onToken }).catch(() => {})
    if (await dialNetflix(ip, url)) {
      log('Netflix opened to the title over DIAL')
      const ws = await connect(ip, token, onToken).catch(() => null)
      if (ws) { await pickProfile(ws, profile); ws.close() }
      return { deep: true }
    }
  }
  if (!APPS[service]) throw new Error(`No TV app known for ${service}`)
  log(`opening ${service} on ${ip}${token ? '' : ' (first time: accept the Allow prompt on the TV)'}`)
  const ws = await connect(ip, token, onToken)
  await exitArtMode(ip, { token: token || latestToken, onToken })
  // Show whatever the TV answers to launch commands (errors, acks), to see why a launch is refused.
  ws.on('message', (raw) => {
    const text = String(raw)
    if (!text.includes('ed.installedApp.get')) log(`TV says: ${text.slice(0, 300)}`)
  })
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
    // The REST launcher first: it answers on TVs whose remote socket ignores app commands.
    for (const id of ids) attempts.push([`REST launch ${id}`, () => restLaunch(ip, id), id])
    for (const id of ids) {
      if (service === 'netflix' && meta) attempts.push([`deep link ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK', meta), id])
      attempts.push([`launch ${id}`, () => wsLaunch(ws, id, 'DEEP_LINK'), id])
      attempts.push([`native launch ${id}`, () => wsLaunch(ws, id, 'NATIVE_LAUNCH'), id])
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
      if (ok) { log(`${label}: app is running`); await pickProfile(ws, profile); return { deep: false } }
      if (ok === null) {
        // This TV won't say whether the app opened; send a few variants, then stop.
        log(`${label}: sent (TV doesn't report running apps)`)
        await sleep(1500)
        if (++unverified >= 3) { await pickProfile(ws, profile); return { deep: false } }
        continue
      }
      log(`${label}: app didn't open`)
    }
    if (unverified) { await pickProfile(ws, profile); return { deep: false } }
    throw new Error(`The TV didn't open ${service}`)
  } finally {
    await sleep(500)
    try { ws.close() } catch {}
  }
}
