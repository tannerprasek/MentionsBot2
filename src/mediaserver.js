// A minimal UPnP/DLNA media server ("CastBot") so Roku Media Player — the one player a Roku TV
// without "Play on Roku" still has — can browse to what's playing and stream it from CastBot.
import ssdp from 'node-ssdp'
import crypto from 'node:crypto'
import { config } from './config.js'

const UDN = 'uuid:' + crypto.createHash('sha1').update('castbot-media-server').digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5')
const CD = 'urn:schemas-upnp-org:service:ContentDirectory:1'
const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1'

let item = null // { title, url, mime, size }
let updateId = 1

// The one video CastBot is offering right now (null clears it).
export function setMediaItem (next) {
  item = next
  updateId++
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

function didl (children, container) {
  const body = children.map((i) =>
    `<item id="now" parentID="0" restricted="1"><dc:title>${esc(i.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class>` +
    `<res protocolInfo="http-get:*:${i.mime}:DLNA.ORG_OP=01;DLNA.ORG_CI=0" size="${i.size || 0}">${esc(i.url)}</res></item>`).join('')
  const cont = container
    ? `<container id="0" parentID="-1" restricted="1" childCount="${item ? 1 : 0}"><dc:title>CastBot</dc:title><upnp:class>object.container</upnp:class></container>`
    : ''
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' + cont + body + '</DIDL-Lite>'
}

const envelope = (action, service, inner) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${service}">${inner}</u:${action}Response></s:Body></s:Envelope>`

const arg = (xml, name) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? ''

function browse (xml) {
  const id = arg(xml, 'ObjectID')
  const flag = arg(xml, 'BrowseFlag')
  const list = item ? [item] : []
  let result
  let n
  if (flag === 'BrowseMetadata') {
    result = id === 'now' && item ? didl([item], false) : didl([], true)
    n = 1
  } else {
    result = id === '0' ? didl(list, false) : didl([], false)
    n = id === '0' ? list.length : 0
  }
  return envelope('Browse', CD, `<Result>${esc(result)}</Result><NumberReturned>${n}</NumberReturned><TotalMatches>${n}</TotalMatches><UpdateID>${updateId}</UpdateID>`)
}

const deviceXml = (base) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>
<device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>CastBot</friendlyName>
<manufacturer>CastBot</manufacturer><modelName>CastBot</modelName><UDN>${UDN}</UDN>
<serviceList>
<service><serviceType>${CD}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/dlna/cd.xml</SCPDURL><controlURL>/dlna/cd/control</controlURL><eventSubURL>/dlna/cd/event</eventSubURL></service>
<service><serviceType>${CM}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/dlna/cm.xml</SCPDURL><controlURL>/dlna/cm/control</controlURL><eventSubURL>/dlna/cm/event</eventSubURL></service>
</serviceList><URLBase>${base}/</URLBase></device></root>`

const action = (name, args) => `<action><name>${name}</name><argumentList>${args.map(([n, d, v]) => `<argument><name>${n}</name><direction>${d}</direction><relatedStateVariable>${v}</relatedStateVariable></argument>`).join('')}</argumentList></action>`
const stateVar = (name, type, events = 'no') => `<stateVariable sendEvents="${events}"><name>${name}</name><dataType>${type}</dataType></stateVariable>`
const scpd = (actions, vars) => `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions}</actionList><serviceStateTable>${vars}</serviceStateTable></scpd>`

const CD_SCPD = scpd(
  action('Browse', [['ObjectID', 'in', 'A_ARG_TYPE_ObjectID'], ['BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'], ['Filter', 'in', 'A_ARG_TYPE_Filter'], ['StartingIndex', 'in', 'A_ARG_TYPE_Index'], ['RequestedCount', 'in', 'A_ARG_TYPE_Count'], ['SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'], ['Result', 'out', 'A_ARG_TYPE_Result'], ['NumberReturned', 'out', 'A_ARG_TYPE_Count'], ['TotalMatches', 'out', 'A_ARG_TYPE_Count'], ['UpdateID', 'out', 'A_ARG_TYPE_UpdateID']]) +
  action('GetSystemUpdateID', [['Id', 'out', 'SystemUpdateID']]) +
  action('GetSearchCapabilities', [['SearchCaps', 'out', 'SearchCapabilities']]) +
  action('GetSortCapabilities', [['SortCaps', 'out', 'SortCapabilities']]),
  ['A_ARG_TYPE_ObjectID:string', 'A_ARG_TYPE_BrowseFlag:string', 'A_ARG_TYPE_Filter:string', 'A_ARG_TYPE_Index:ui4', 'A_ARG_TYPE_Count:ui4', 'A_ARG_TYPE_SortCriteria:string', 'A_ARG_TYPE_Result:string', 'A_ARG_TYPE_UpdateID:ui4', 'SearchCapabilities:string', 'SortCapabilities:string']
    .map((v) => stateVar(...v.split(':'))).join('') + stateVar('SystemUpdateID', 'ui4', 'yes')
)
const CM_SCPD = scpd(action('GetProtocolInfo', [['Source', 'out', 'SourceProtocolInfo'], ['Sink', 'out', 'SinkProtocolInfo']]), stateVar('SourceProtocolInfo', 'string', 'yes') + stateVar('SinkProtocolInfo', 'string', 'yes'))

// Adds the media-server routes to the express app and starts announcing it on the network.
export function startMediaServer (app, express) {
  const base = () => `http://${config.publicHost}:${config.port}`
  const xml = (res, body) => res.type('text/xml; charset="utf-8"').send(body)
  const raw = express.text({ type: () => true, limit: '1mb' })

  app.get('/dlna/device.xml', (_req, res) => xml(res, deviceXml(base())))
  app.get('/dlna/cd.xml', (_req, res) => xml(res, CD_SCPD))
  app.get('/dlna/cm.xml', (_req, res) => xml(res, CM_SCPD))

  app.post('/dlna/cd/control', raw, (req, res) => {
    const act = (req.get('soapaction') || '').replace(/"/g, '').split('#')[1] || ''
    if (act === 'Browse') return xml(res, browse(String(req.body)))
    if (act === 'GetSystemUpdateID') return xml(res, envelope(act, CD, `<Id>${updateId}</Id>`))
    if (act === 'GetSearchCapabilities') return xml(res, envelope(act, CD, '<SearchCaps></SearchCaps>'))
    if (act === 'GetSortCapabilities') return xml(res, envelope(act, CD, '<SortCaps></SortCaps>'))
    res.status(500).type('text/xml').send('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring></s:Fault></s:Body></s:Envelope>')
  })
  app.post('/dlna/cm/control', raw, (req, res) => xml(res, envelope('GetProtocolInfo', CM, '<Source>http-get:*:video/mp4:*,http-get:*:video/x-matroska:*</Source><Sink></Sink>')))
  // Event subscriptions: accepted, never used.
  app.use(['/dlna/cd/event', '/dlna/cm/event'], (req, res) => res.set({ SID: 'uuid:castbot-events', TIMEOUT: 'Second-1800' }).sendStatus(200))

  const server = new ssdp.Server({ location: `${base()}/dlna/device.xml`, udn: UDN, ssdpSig: 'CastBot/1.0 UPnP/1.0' })
  server.addUSN('upnp:rootdevice')
  server.addUSN('urn:schemas-upnp-org:device:MediaServer:1')
  server.addUSN(CD)
  server.addUSN(CM)
  server.start().catch((err) => console.error('[dlna]', err.message))
}
