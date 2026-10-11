// Plays a URL on a UPnP/DLNA media renderer (LG and many other smart TVs) via AVTransport.
import { XMLParser } from 'fast-xml-parser'
import { onSsdp } from './ssdp.js'

const parser = new XMLParser({ ignoreAttributes: true })
const renderers = new Map() // ip -> { name, avt: {url, type}, rc: {url, type} }

onSsdp(async ({ st, location, ip }) => {
  if (!st.includes('MediaRenderer') || !location || renderers.has(ip)) return
  renderers.set(ip, null)
  try {
    const xml = await (await fetch(location, { signal: AbortSignal.timeout(4000) })).text()
    const doc = parser.parse(xml).root
    const base = doc.URLBase || new URL(location).origin
    const list = (dev) => [].concat(dev?.serviceList?.service || [])
      .concat(...[].concat(dev?.deviceList?.device || []).map(list))
    const services = list(doc.device)
    const svc = (kind) => {
      const s = services.find((x) => String(x.serviceType).includes(`:service:${kind}:`))
      return s && { url: new URL(s.controlURL, base).href, type: s.serviceType }
    }
    const avt = svc('AVTransport')
    if (avt) renderers.set(ip, { name: doc.device.friendlyName, avt, rc: svc('RenderingControl') })
  } catch {
    renderers.delete(ip)
  }
})

export const hasRenderer = (ip) => Boolean(renderers.get(ip))

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

async function soap (svc, action, args) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${svc.type}">${Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</u:${action}>` +
    '</s:Body></s:Envelope>'
  const res = await fetch(svc.url, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${svc.type}#${action}"` },
    body,
    signal: AbortSignal.timeout(10_000)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`TV rejected ${action} (HTTP ${res.status})`)
  return parser.parse(text)
}

export async function dlnaPlay (ip, url, title, mime, startAt = 0) {
  const r = renderers.get(ip)
  if (!r) throw new Error('This TV has no DLNA player')
  const didl = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class>` +
    `<res protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0">${esc(url)}</res></item></DIDL-Lite>`
  await soap(r.avt, 'Stop', { InstanceID: 0 }).catch(() => {})
  await soap(r.avt, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl })
  await soap(r.avt, 'Play', { InstanceID: 0, Speed: 1 })
  if (startAt > 0) {
    // Renderers only accept a seek once playback has started.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const ok = await soap(r.avt, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: toTime(startAt) }).then(() => true, () => false)
      if (ok) break
    }
  }
}

// { position, duration, state } from the renderer, in seconds.
export async function dlnaProgress (ip) {
  const r = renderers.get(ip)
  if (!r) return null
  const pos = JSON.stringify(await soap(r.avt, 'GetPositionInfo', { InstanceID: 0 }))
  const tr = JSON.stringify(await soap(r.avt, 'GetTransportInfo', { InstanceID: 0 }))
  const t = (k) => pos.match(new RegExp(`"${k}":"([\\d:.]+)"`))?.[1]
  const st = tr.match(/"CurrentTransportState":"([A-Z_]+)"/)?.[1] || 'STOPPED'
  const map = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', TRANSITIONING: 'buffering' }
  return { position: toSec(t('RelTime')), duration: toSec(t('TrackDuration')), state: map[st] || 'stopped' }
}

const toSec = (t) => String(t || '0:0:0').split(':').reduce((a, b) => a * 60 + Number(b || 0), 0)
const toTime = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, Math.floor(s % 60)].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':')

export async function dlnaControl (ip, action, value) {
  const r = renderers.get(ip)
  if (!r) throw new Error('This TV has no DLNA player')
  switch (action) {
    case 'pause': return soap(r.avt, 'Pause', { InstanceID: 0 })
    case 'resume': return soap(r.avt, 'Play', { InstanceID: 0, Speed: 1 })
    case 'stop': return soap(r.avt, 'Stop', { InstanceID: 0 })
    case 'seek': {
      const pos = await soap(r.avt, 'GetPositionInfo', { InstanceID: 0 })
      const rel = JSON.stringify(pos).match(/"RelTime":"([\d:]+)"/)?.[1]
      return soap(r.avt, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: toTime(Math.max(0, toSec(rel) + Number(value))) })
    }
    case 'volume':
      if (!r.rc) throw new Error('This TV does not allow volume control')
      return soap(r.rc, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(Number(value) * 100) })
    default: throw new Error(`Unknown action ${action}`)
  }
}
