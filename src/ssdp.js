// One shared SSDP client for finding Roku, LG and DLNA devices on the network.
import ssdp from 'node-ssdp'

const TARGETS = [
  'roku:ecp',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1'
]

const client = new ssdp.Client()
const handlers = []

client.on('response', (headers, statusCode, rinfo) => {
  if (statusCode !== 200) return
  const st = String(headers.ST || headers.NT || '')
  for (const h of handlers) {
    try { h({ st, location: headers.LOCATION, usn: headers.USN || '', ip: rinfo.address }) } catch {}
  }
})

export function onSsdp (handler) {
  handlers.push(handler)
}

export function searchSsdp () {
  for (const t of TARGETS) client.search(t)
}

searchSsdp()
