import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, EDITABLE, saveSettings } from './config.js'
import { parseRequest } from './query.js'
import { search, resolveTorrent } from './search.js'
import { startTorrent, stopTorrent, currentFile, stats } from './torrent.js'
import { listDevices, waitForDevice, play, stopCast, control } from './cast.js'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')))

let status = { state: 'idle' }
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
  res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*' })
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
  const stream = file.createReadStream({ start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
})

async function startPlayback (parsed, result, tvName) {
  try {
    setStatus({ state: 'finding-tv', title: parsed.title, release: result.title })
    const device = await waitForDevice(tvName)
    if (!device) throw new Error(`Chromecast "${tvName}" not found`)

    setStatus({ state: 'connecting', title: parsed.title, release: result.title, tv: device.friendlyName })
    const file = await startTorrent(await resolveTorrent(result.link), parsed)
    const url = `http://${config.publicHost}:${config.port}/stream/${encodeURIComponent(file.name)}`

    await play(device, url, parsed.title)
    setStatus({ state: 'playing', title: parsed.title, release: result.title, file: file.name, tv: device.friendlyName })
  } catch (err) {
    setStatus({ state: 'error', title: parsed.title, error: err.message })
  }
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

app.get('/api/settings', auth, (_req, res) => {
  res.json(Object.fromEntries(EDITABLE.map((k) => [k, config[k]])))
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
    startPlayback(parsed, best, tvName)
    res.json({
      ok: true,
      query: parsed.query,
      release: best.title,
      seeders: best.seeders,
      tv: tvName || '(first found)',
      speak: `Starting ${parsed.title} on ${tvName || 'your TV'}.`
    })
  } catch (err) {
    setStatus({ state: 'error', title: parsed.title, error: err.message })
    res.status(500).json({ error: err.message, speak: `Something went wrong: ${err.message}` })
  }
})

app.post('/stop', auth, async (_req, res) => {
  await stopCast().catch(() => {})
  await stopTorrent()
  setStatus({ state: 'idle' })
  res.json({ ok: true, speak: 'Stopped.' })
})

app.post('/control/:action', auth, async (req, res) => {
  try {
    await control(req.params.action, req.body?.value ?? req.query.value)
    res.json({ ok: true, speak: 'Done.' })
  } catch (err) {
    res.status(400).json({ error: err.message, speak: err.message })
  }
})

app.get('/devices', auth, (_req, res) => res.json(listDevices()))
app.get('/status', auth, (_req, res) => res.json({ ...status, torrent: stats() }))

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CastBot is running. Open http://localhost:${config.port} in Chrome`)
  console.log(`(from your phone: http://${config.publicHost}:${config.port})`)
})
