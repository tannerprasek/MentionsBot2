// Samsung (Tizen) TVs: detection, and switching a Frame out of Art Mode before casting.
import WebSocket from 'ws'
import net from 'node:net'

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
