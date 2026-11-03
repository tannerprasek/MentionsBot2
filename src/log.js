// Keeps everything the server prints (and any crash) so the web page can show it, and in castbot.log.
import fs from 'node:fs'
import util from 'node:util'

const FILE = new URL('../castbot.log', import.meta.url)
const MAX_LINES = 1500
const lines = []

try { if (fs.statSync(FILE).size > 1_000_000) fs.truncateSync(FILE, 0) } catch {}

function record (level, args) {
  const line = `${new Date().toISOString().slice(11, 19)} ${level === 'log' ? '' : level.toUpperCase() + ' '}${util.format(...args)}`
  lines.push(line)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  try { fs.appendFileSync(FILE, new Date().toISOString() + ' ' + line.slice(9) + '\n') } catch {}
}

for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console)
  console[level] = (...args) => { record(level, args); try { orig(...args) } catch {} }
}
process.on('uncaughtException', (err) => console.error('[crash]', err?.stack || err))
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.stack || err))

export const logText = () => lines.join('\n')
