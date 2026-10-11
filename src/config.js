import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function lanIp () {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v))
const SETTINGS_FILE = path.resolve(process.env.SETTINGS_FILE || './settings.json')

export const config = {
  port: Number(process.env.PORT || 8787),
  // Address the Chromecast uses to reach this server. Must be a LAN address.
  publicHost: process.env.PUBLIC_HOST || lanIp(),
  apiToken: process.env.API_TOKEN || '',
  torznabUrl: process.env.TORZNAB_URL || '',
  torznabApiKey: process.env.TORZNAB_API_KEY || '',
  downloadDir: process.env.DOWNLOAD_DIR || './downloads',
  defaultTv: process.env.DEFAULT_TV || '',
  preferredQuality: process.env.PREFERRED_QUALITY || '1080p',
  allow4k: bool(process.env.ALLOW_4K, false),
  avoidHevc: bool(process.env.AVOID_HEVC, true),
  maxSizeGb: Number(process.env.MAX_SIZE_GB || 15),
  minSeeders: Number(process.env.MIN_SEEDERS || 3),
  // Services checked before torrenting; if the title is on one, CastBot says so instead of torrenting.
  streamingServices: (process.env.STREAMING_SERVICES ?? 'netflix,disneyplus,appletvplus').split(',').filter(Boolean),
  streamingCountry: process.env.STREAMING_COUNTRY || 'US',
  // Remote-control tokens Samsung TVs hand out after you press Allow, keyed by TV IP.
  samsungTokens: {},
  // Pairing keys LG TVs hand out after you accept the prompt, keyed by TV IP.
  lgKeys: {}
}

// Settings saved from the web page; these override .env.
export const EDITABLE = ['torznabUrl', 'torznabApiKey', 'defaultTv', 'preferredQuality', 'allow4k', 'avoidHevc', 'maxSizeGb', 'minSeeders', 'streamingServices', 'streamingCountry']
const SAVED = [...EDITABLE, 'samsungTokens', 'lgKeys']

try {
  Object.assign(config, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')))
} catch {}

export function saveSettings (input) {
  for (const key of EDITABLE) {
    if (!(key in input)) continue
    const cur = config[key]
    const v = input[key]
    config[key] = Array.isArray(cur) ? [].concat(v).map(String)
      : typeof cur === 'boolean' ? Boolean(v)
        : typeof cur === 'number' ? Number(v)
          : String(v).trim()
  }
  writeSettings()
}

export function saveDeviceKey (store, ip, key) {
  config[store] = { ...config[store], [ip]: key }
  writeSettings()
}

function writeSettings () {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, config[k]])), null, 2))
}
