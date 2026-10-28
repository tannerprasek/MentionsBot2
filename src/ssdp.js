// Finds Roku, LG and DLNA devices on the network with SSDP: a broadcast search, plus direct
// (unicast) searches for addresses already known, which still work when a router or Wi-Fi
// access point drops broadcast traffic between devices.
import ssdp from 'node-ssdp'
import dgram from 'node:dgram'

const TARGETS = [
  'roku:ecp',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1'
]

const handlers = []

function dispatch (headers, ip) {
  const st = String(headers.ST || headers.NT || '')
  for (const h of handlers) {
    try { h({ st, location: headers.LOCATION, usn: headers.USN || '', ip }) } catch {}
  }
}

function makeClient () {
  const c = new ssdp.Client()
  c.on('response', (headers, statusCode, rinfo) => { if (statusCode === 200) dispatch(headers, rinfo.address) })
  c.on('error', (err) => console.error('[ssdp]', err.message))
  return c
}

let client = makeClient()

export function onSsdp (handler) {
  handlers.push(handler)
}

export function searchSsdp () {
  // No network (Wi-Fi off, cable out) means no sockets to search with; that's not an error to crash on.
  for (const t of TARGETS) client.search(t)?.catch?.(() => {})
}

// Rebuilds the search sockets (they go stale after the PC sleeps or changes networks).
export function resetSsdp () {
  try { client.stop() } catch {}
  client = makeClient()
  searchSsdp()
}

// Asks one address directly. Resolves with how many answers came back.
export function probeSsdp (ip, waitMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    let seen = 0
    sock.on('error', () => {})
    sock.on('message', (msg, rinfo) => {
      const [first, ...lines] = String(msg).split('\r\n')
      if (!/^HTTP\/1\.[01] 200/.test(first)) return
      const headers = {}
      for (const l of lines) {
        const i = l.indexOf(':')
        if (i > 0) headers[l.slice(0, i).trim().toUpperCase()] = l.slice(i + 1).trim()
      }
      seen++
      dispatch(headers, rinfo.address)
    })
    sock.bind(0, () => {
      for (const st of TARGETS) {
        sock.send(Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${ip}:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`), 1900, ip, () => {})
      }
      setTimeout(() => { try { sock.close() } catch {} resolve(seen) }, waitMs)
    })
  })
}

searchSsdp()
