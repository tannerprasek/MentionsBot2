import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, EDITABLE, saveSettings } from './config.js'
import { parseRequest } from './query.js'
import { search, resolveTorrent } from './search.js'
import { startTorrent, stopTorrent, currentFile, stats, clearDownloads } from './torrent.js'
import { prowlarrStatus } from './prowlarr.js'
import fs from 'node:fs'
import { findStreaming } from './streaming.js'
import { listDevices, pickDevice, onPlaybackFinished, playOn, openAppOn, canOpenApps, stopPlayback, controlActive } from './tvs.js'

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')))

let status = { state: 'idle' }

// Downloaded files are deleted once nobody is watching: when a Chromecast reports the video
// finished, or when nothing has been streamed for IDLE_HOURS (Roku/LG don't report the end).
const IDLE_MS = Number(process.env.IDLE_HOURS || 2) * 3600_000
let lastServed = Date.now()

async function finishAndCleanUp (reason) {
  if (!currentFile()) return
  console.log(`[cleanup] ${reason}; deleting the download`)
  await stopTorrent()
  setStatus({ state: 'idle' })
}

clearDownloads()
onPlaybackFinished(() => finishAndCleanUp('video finished'))
setInterval(() => {
  if (currentFile() && Date.now() - lastServed > IDLE_MS) {
    stopPlayback().catch(() => {})
    finishAndCleanUp('nothing streamed for a while')
  }
}, 60_000).unref()
const setStatus = (s) => { status = { ...s, at: new Date().toISOString() }; console.log('[status]', status) }

function auth (req, res, next) {
  if (!config.apiToken) return next()
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.token || req.body?.token
  if (token === config.apiToken) return next()
  res.status(401).json({ error: 'unauthorized' })
}

// Range-capable stream of the selected torrent file; this is what the Chromecast loads.
app.get('/stream/:name', (req, res) => {
  const file = currentFile()
  if (!file) return res.sendStatus(404)
  const size = file.length
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/)
  // Chromecast is told the file is MP4 (it plays H.264 MKVs that way); DLNA/Roku players get the real type.
  const type = req.query.cast || /\.mp4$/i.test(file.name) ? 'video/mp4' : /\.mkv$/i.test(file.name) ? 'video/x-matroska' : 'video/mp4'
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
  })
  if (req.method === 'HEAD') return res.set('Content-Length', size).end()

  let start = 0
  let end = size - 1
  if (range) {
    start = range[1] ? Number(range[1]) : size - Number(range[2])
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) return res.status(416).set('Content-Range', `bytes */${size}`).end()
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  res.set('Content-Length', end - start + 1)
  lastServed = Date.now()
  const stream = file.createReadStream({ start, end })
  stream.on('data', () => { lastServed = Date.now() })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
})

async function startPlayback (parsed, result, device) {
  try {
    setStatus({ state: 'connecting', title: parsed.title, release: result.title, tv: device.name })
    const file = await startTorrent(await resolveTorrent(result.link), parsed)
    lastServed = Date.now()
    const url = `http://${config.publicHost}:${config.port}/stream/${encodeURIComponent(file.name)}${device.ref ? '?cast=1' : ''}`

    await playOn(device, url, parsed.title, file.name)
    setStatus({ state: 'playing', title: parsed.title, release: result.title, file: file.name, tv: device.name })
  } catch (err) {
    console.error(err.stack)
    setStatus({ state: 'error', title: parsed.title, error: err.message })
  }
}

// If the title is on one of the user's services, open that app on the TV instead of torrenting.
// Returns true when it has sent the response.
async function tryStreaming (parsed, tvName, res) {
  setStatus({ state: 'searching', title: parsed.title })
  const hit = await findStreaming(parsed, config.streamingServices, config.streamingCountry).catch((err) => {
    console.error('[streaming]', err.message)
    return null
  })
  if (!hit) return false

  const { device } = await pickDevice(tvName, config.defaultTv)
  if (!device || !(await canOpenApps(device))) {
    setStatus({ state: 'streaming', title: hit.title, service: hit.serviceName, url: hit.url })
    res.json({ ok: true, streaming: hit, speak: `${hit.title} is on ${hit.serviceName}. Open it in the ${hit.serviceName} app.` })
    return true
  }

  const tv = device.name
  await stopPlayback().catch(() => {})
  await stopTorrent()
  setStatus({ state: 'opening-app', title: hit.title, service: hit.serviceName, tv, url: hit.url })
  res.json({ ok: true, streaming: hit, tv, speak: `${hit.title} is on ${hit.serviceName}. Opening it on ${tv}.` })

  openAppOn(device, hit.service, hit.url, hit.isSeries)
    .then(() => setStatus({ state: 'streaming', title: hit.title, service: hit.serviceName, tv, url: hit.url }))
    .catch((err) => setStatus({ state: 'error', title: hit.title, error: `Couldn't open ${hit.serviceName}: ${err.message}` }))
  return true
}

app.get('/api/search', auth, async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'q is required' })
  const parsed = parseRequest(String(req.query.q))
  try {
    const results = await search(parsed)
    res.json({ query: parsed.query, results: results.slice(0, 25) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/settings', auth, async (_req, res) => {
  const prowlarr = config.torznabUrl ? null : await prowlarrStatus(config.torznabApiKey || undefined)
  res.json({ ...Object.fromEntries(EDITABLE.map((k) => [k, config[k]])), prowlarr })
})

app.post('/api/settings', auth, (req, res) => {
  saveSettings(req.body || {})
  res.json({ ok: true })
})

// Body: { title, tv } plays the best match. Add { link, release } to play a specific search result.
app.post('/play', auth, async (req, res) => {
  const text = req.body?.title || req.body?.text || req.query.title
  const tvName = req.body?.tv || req.query.tv || config.defaultTv
  if (!text) return res.status(400).json({ error: 'title is required', speak: 'What do you want to watch?' })

  const parsed = parseRequest(text)
  try {
    if (!req.body?.link && !parsed.force && !req.body?.force) {
      const handled = await tryStreaming(parsed, tvName, res)
      if (handled) return
    }

    let best
    if (req.body?.link) {
      best = { title: req.body.release || parsed.title, link: req.body.link, seeders: req.body.seeders }
    } else {
      setStatus({ state: 'searching', title: parsed.title })
      const results = await search(parsed)
      if (!results.length) {
        setStatus({ state: 'error', title: parsed.title, error: 'no results' })
        return res.status(404).json({ error: 'no results', speak: `I couldn't find ${parsed.title}.` })
      }
      best = results[0]
    }
    const { device, exact } = await pickDevice(tvName, config.defaultTv)
    if (!device) {
      setStatus({ state: 'error', title: parsed.title, error: 'No TVs found on the network' })
      return res.status(404).json({ error: 'no TVs found', speak: "I couldn't find any TVs on your network." })
    }
    const tv = device.name
    const speak = !exact && tvName
      ? `I couldn't find a TV called ${tvName}, so I'm playing ${parsed.title} on ${tv}.`
      : `Starting ${parsed.title} on ${tv}.`
    setStatus({ state: 'connecting', title: parsed.title, release: best.title, tv })
    startPlayback(parsed, best, device)
    res.json({ ok: true, query: parsed.query, release: best.title, seeders: best.seeders, tv, fallback: !exact, speak })
  } catch (err) {
    setStatus({ state: 'error', title: parsed.title, error: err.message })
    res.status(500).json({ error: err.message, speak: `Something went wrong: ${err.message}` })
  }
})

app.post('/stop', auth, async (_req, res) => {
  await stopPlayback().catch(() => {})
  await stopTorrent()
  setStatus({ state: 'idle' })
  res.json({ ok: true, speak: 'Stopped.' })
})

app.post('/control/:action', auth, async (req, res) => {
  try {
    await controlActive(req.params.action, req.body?.value ?? req.query.value)
    res.json({ ok: true, speak: 'Done.' })
  } catch (err) {
    res.status(400).json({ error: err.message, speak: err.message })
  }
})

app.get('/api/version', (_req, res) => res.json({ version }))
app.get('/devices', auth, (_req, res) => res.json(listDevices().map(({ name, kind, ref }) => ({ name, kind, cast: Boolean(ref) }))))
app.get('/status', auth, (_req, res) => res.json({ ...status, torrent: stats() }))

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CastBot v${version} is running. Open http://localhost:${config.port} in Chrome`)
  console.log(`(from your phone: http://${config.publicHost}:${config.port})`)
})
