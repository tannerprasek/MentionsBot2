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
  minSeeders: Number(process.env.MIN_SEEDERS || 3)
}

// Settings saved from the web page; these override .env.
export const EDITABLE = ['torznabUrl', 'torznabApiKey', 'defaultTv', 'preferredQuality', 'allow4k', 'avoidHevc', 'maxSizeGb', 'minSeeders']

try {
  Object.assign(config, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')))
} catch {}

export function saveSettings (input) {
  for (const key of EDITABLE) {
    if (!(key in input)) continue
    const cur = config[key]
    config[key] = typeof cur === 'boolean' ? Boolean(input[key]) : typeof cur === 'number' ? Number(input[key]) : String(input[key]).trim()
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(Object.fromEntries(EDITABLE.map((k) => [k, config[k]])), null, 2))
}
