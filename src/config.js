import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The home-network address TVs and phones can reach. Skips VPN/virtual adapters (Tailscale's
// 100.64.0.0/10, Hyper-V/WSL, VirtualBox, VMware, Docker) and prefers private LAN ranges.
const VIRTUAL = /tailscale|zerotier|vethernet|hyper-v|wsl|virtualbox|vmware|vbox|docker|loopback|utun|tun|tap|wireguard|vpn/i
function rank (name, ip) {
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || ip.startsWith('169.254.')) return 0 // CGNAT/VPN, link-local
  if (VIRTUAL.test(name)) return 1
  if (/^192\.168\./.test(ip)) return 4
  if (/^10\./.test(ip)) return 4
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3
  return 2
}
export function lanAddresses () {
  const out = []
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address, rank: rank(name, i.address) })
    }
  }
  return out.sort((a, b) => b.rank - a.rank)
}
function lanIp () {
  return lanAddresses()[0]?.address || '127.0.0.1'
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
  // Start the next episode when one finishes.
  autoNext: bool(process.env.AUTO_NEXT, true),
  // Replaces the four OK presses CastBot sends in Roku Media Player, e.g. "Down,Select,Select".
  rokuKeys: process.env.ROKU_KEYS || '',
  // Remote-control tokens Samsung TVs hand out after you press Allow, keyed by TV IP.
  samsungTokens: {},
  // Pairing keys LG TVs hand out after you accept the prompt, keyed by TV IP.
  lgKeys: {}
}

// Settings saved from the web page; these override .env.
export const EDITABLE = ['torznabUrl', 'torznabApiKey', 'defaultTv', 'preferredQuality', 'allow4k', 'avoidHevc', 'maxSizeGb', 'minSeeders', 'autoNext', 'rokuKeys']
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
