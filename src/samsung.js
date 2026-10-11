// Opens streaming apps on Samsung (Tizen) TVs through the TV's local remote-control API.
import WebSocket from 'ws'

const APPS = {
  netflix: '3201907018807',
  disneyplus: '3201901017640',
  appletvplus: '3201807016597'
}

export async function isSamsung (ip) {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(2500) })
    const info = await res.json()
    return /samsung/i.test(JSON.stringify(info.device || info))
  } catch {
    return false
  }
}

function deepLink (service, url) {
  if (service === 'netflix') {
    const id = url.match(/title\/(\d+)/)?.[1]
    return id ? `m=${id}&source_type=4` : ''
  }
  return url
}

// The first connection makes the TV show an "Allow" prompt; the token it returns is saved via onToken.
export function openApp (ip, service, url, { token, onToken } = {}) {
  const appId = APPS[service]
  if (!appId) return Promise.reject(new Error(`No TV app known for ${service}`))
  const name = Buffer.from('CastBot').toString('base64')
  const wsUrl = `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${name}${token ? `&token=${token}` : ''}`

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('The TV did not respond. If it showed an "Allow" prompt, accept it and try again.'))
    }, 30_000)
    const done = (err) => { clearTimeout(timer); try { ws.close() } catch {}; err ? reject(err) : resolve() }

    ws.on('error', (err) => done(err))
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.event === 'ms.channel.unauthorized') return done(new Error('The TV refused the connection. Allow CastBot on the TV and try again.'))
      if (msg.event !== 'ms.channel.connect') return
      if (msg.data?.token && msg.data.token !== token) onToken?.(msg.data.token)
      ws.send(JSON.stringify({
        method: 'ms.channel.emit',
        params: {
          event: 'ed.apps.launch',
          to: 'host',
          data: { appId, action_type: 'DEEP_LINK', metaTag: deepLink(service, url) }
        }
      }))
      // The TV doesn't acknowledge launches; give it a moment to receive the command.
      setTimeout(() => done(), 1500)
    })
  })
}
