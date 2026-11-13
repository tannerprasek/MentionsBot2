// Self-repair and plain-English advice for errors.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { prowlarrStatus, findProwlarrKey } from './prowlarr.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let starting = null

function prowlarrPrograms () {
  const e = process.env
  return [
    e.ProgramData && path.join(e.ProgramData, 'Prowlarr', 'bin', 'Prowlarr.exe'),
    'C:\\ProgramData\\Prowlarr\\bin\\Prowlarr.exe',
    e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Prowlarr', 'bin', 'Prowlarr.exe'),
    e.ProgramFiles && path.join(e.ProgramFiles, 'Prowlarr', 'bin', 'Prowlarr.exe'),
    e.ProgramFiles && path.join(e.ProgramFiles, 'Prowlarr', 'Prowlarr.exe'),
    e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Programs', 'Prowlarr', 'Prowlarr.exe')
  ].filter(Boolean)
}

// Prowlarr isn't answering: start it, then wait until it does. Returns true once it's up.
export function startProwlarr () {
  if (starting) return starting
  starting = (async () => {
    if (!findProwlarrKey()) return false // not installed here
    console.log('[heal] Prowlarr is not running; starting it')
    try {
      if (process.platform === 'win32') {
        const exe = prowlarrPrograms().find((p) => fs.existsSync(p))
        if (exe) spawn(exe, ['-tray'], { detached: true, stdio: 'ignore' }).unref()
        else execFile('sc', ['start', 'Prowlarr'], () => {})
      } else if (process.platform === 'darwin') {
        execFile('open', ['-a', 'Prowlarr'], () => {})
      } else {
        execFile('systemctl', ['start', 'prowlarr'], () => {})
      }
    } catch (err) { console.error('[heal] could not start Prowlarr:', err.message) }
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      if ((await prowlarrStatus()).found) { console.log('[heal] Prowlarr is back'); return true }
    }
    console.log('[heal] Prowlarr did not come up')
    return false
  })().finally(() => { starting = null })
  return starting
}

// What to tell the user to do about an error. Returns a short instruction, or '' if the message already says it.
const RULES = [
  [/Can't reach Prowlarr|Prowlarr not running|not running/i, "CastBot tried to start Prowlarr and couldn't. Open Prowlarr yourself (Start menu → Prowlarr), wait 10 seconds, then try again."],
  [/Prowlarr not found/i, 'Install Prowlarr from prowlarr.com, add some indexers in it, then try again. Or paste a Torznab URL in ⚙ Settings.'],
  [/Prowlarr search failed: HTTP 401|Indexer search failed: HTTP 401/i, "The search key is wrong. In ⚙ Settings clear the Torznab API key and URL so CastBot reads Prowlarr's key itself."],
  [/HTTP 5\d\d/i, 'The search site is having trouble. Wait a minute and try again.'],
  [/Can't reach the Torznab/i, 'Check the Torznab URL in ⚙ Settings, and that the program it points to is running.'],
  [/no results/i, 'Nothing matched. In Prowlarr, make sure at least a few indexers are added and enabled, or try "Show all results" with a looser name.'],
  [/No TVs found/i, 'Switch the TV on (not standby), make sure this PC is on the same Wi-Fi, then tap ↻ next to the TV list.'],
  [/metadata|no peers/i, 'That release has no one sharing it. Tap "Show all results" and pick one with more seeders.'],
  [/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i, 'A network connection failed. Check this PC is online and on the same Wi-Fi as the TV, then try again.'],
  [/fetch failed/i, 'A network connection failed. Check this PC is online, then try again.'],
  [/DLNA|didn't respond|did not respond/i, 'Make sure the TV is fully on, then try again. CastBot is searching for it again now.']
]
export function adviceFor (message = '') {
  for (const [re, advice] of RULES) if (re.test(message)) return advice
  return 'Something unexpected went wrong. Tap 📋 Log and send me the last lines.'
}
