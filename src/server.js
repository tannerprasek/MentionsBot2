import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, EDITABLE, saveSettings } from './config.js'
import { parseRequest } from './query.js'
import { search } from './search.js'
import { currentFile, stats, clearDownloads } from './torrent.js'
import { prowlarrStatus } from './prowlarr.js'
import fs from 'node:fs'
import { findStreaming } from './streaming.js'
import { listDevices, refreshTvs, pickDevice, canResume, controlActive } from './tvs.js'
import * as player from './player.js'

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')))

let status = { state: 'idle' }

// Downloaded files are deleted once nobody is watching: when the video ends (the player handles
// that, moving on to the next episode if asked), or after IDLE_HOURS with nothing streamed.
const IDLE_MS = Number(process.env.IDLE_HOURS || 2) * 3600_000
let lastServed = Date.now()

clearDownloads()
setInterval(async () => {
  if (currentFile() && Date.now() - lastServed > IDLE_MS) {
    console.log('[cleanup] nothing streamed for a while; deleting the download')
    await player.stop()
    setStatus({ state: 'idle' })
  }
}, 60_000).unref()
const setStatus = (s) => { status = { ...s, at: new Date().toISOString() }; console.log('[status]', status) }
player.onStatus(setStatus)

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

// If the title is on one of the user's services, say where instead of torrenting.
// Returns true when it has sent the response.
async function tryStreaming (parsed, res) {
  setStatus({ state: 'searching', title: parsed.title })
  const hit = await findStreaming(parsed, config.streamingServices, config.streamingCountry).catch((err) => {
    console.error('[streaming]', err.message)
    return null
  })
  if (!hit) return false
  console.log(`[streaming] ${hit.title} is on ${hit.serviceName}`)
  setStatus({ state: 'streaming', title: hit.title, service: hit.serviceName, url: hit.url, note: `Watch it in the ${hit.serviceName} app.` })
  res.json({ ok: true, streaming: hit, speak: `${hit.title} is on ${hit.serviceName}.` })
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
      const handled = await tryStreaming(parsed, res)
      if (handled) return
    }

    // A bare show name continues where you left off; a known episode resumes mid-way.
    const { parsed: planned, resume } = player.plan(parsed)

    let best
    let results
    if (req.body?.link) {
      best = { title: req.body.release || planned.title, link: req.body.link, seeders: req.body.seeders }
    } else {
      setStatus({ state: 'searching', title: planned.title })
      results = await search(planned)
      if (!results.length) {
        setStatus({ state: 'error', title: planned.title, error: 'no results' })
        return res.status(404).json({ error: 'no results', speak: `I couldn't find ${planned.query}.` })
      }
      best = results[0]
    }
    const { device, exact } = await pickDevice(tvName, config.defaultTv)
    if (!device) {
      setStatus({ state: 'error', title: planned.title, error: 'No TVs found on the network' })
      return res.status(404).json({ error: 'no TVs found', speak: "I couldn't find any TVs on your network." })
    }
    const tv = device.name
    const ep = player.describeEpisode(planned)
    const label = ep ? `${planned.title}, ${ep},` : planned.title
    const resumeText = resume && await canResume(device) ? ` from ${player.minutesOf(resume.startAt)} minutes in` : ''
    const speak = (!exact && tvName ? `I couldn't find a TV called ${tvName}. ` : '') +
      `${planned.continued ? 'Continuing' : 'Starting'} ${label} on ${tv}${resumeText}.`
    setStatus({ state: 'connecting', title: planned.title, release: best.title, tv })
    lastServed = Date.now()
    player.start({ parsed: planned, result: best, results, device, resume: resume || undefined })
    res.json({ ok: true, query: planned.query, release: best.title, seeders: best.seeders, tv, fallback: !exact, speak })
  } catch (err) {
    setStatus({ state: 'error', title: parsed.title, error: err.message })
    res.status(500).json({ error: err.message, speak: `Something went wrong: ${err.message}` })
  }
})

app.post('/stop', auth, async (_req, res) => {
  await player.stop()
  setStatus({ state: 'idle' })
  res.json({ ok: true, speak: 'Stopped.' })
})

// "Next episode": the episode after what's playing (or what played last), on the same TV.
app.post('/next', auth, async (_req, res) => {
  try {
    lastServed = Date.now()
    res.json(await player.playNext())
  } catch (err) {
    res.status(500).json({ error: err.message, speak: `Something went wrong: ${err.message}` })
  }
})

// "What's playing?" for Siri.
app.get('/now', auth, (_req, res) => res.json({ ...status, progress: player.progress(), speak: player.describe(status) }))

app.post('/control/:action', auth, async (req, res) => {
  try {
    await controlActive(req.params.action, req.body?.value ?? req.query.value)
    res.json({ ok: true, speak: { pause: 'Paused.', resume: 'Playing.' }[req.params.action] || 'Done.' })
  } catch (err) {
    res.status(400).json({ error: err.message, speak: err.message })
  }
})

app.get('/api/version', (_req, res) => res.json({ version }))
// Plain list of TV names, for the Siri Shortcut's "Choose from List".
app.get('/tvs', auth, async (_req, res) => {
  // Search again first, so a TV switched on a moment ago is in the list.
  refreshTvs()
  await new Promise((r) => setTimeout(r, 1500))
  res.json(listDevices().map((d) => d.name))
})
app.get('/devices', auth, (_req, res) => res.json(listDevices().map(({ name, kind, ref }) => ({ name, kind, cast: Boolean(ref) }))))
app.get('/status', auth, (_req, res) => res.json({ ...status, torrent: stats(), progress: player.progress() }))

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CastBot v${version} is running. Open http://localhost:${config.port} in Chrome`)
  console.log(`(from your phone: http://${config.publicHost}:${config.port})`)
})
