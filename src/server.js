import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, EDITABLE, saveSettings, lanAddresses } from './config.js'
import { HOSTNAME } from './announce.js'
import { parseRequest } from './query.js'
import { search } from './search.js'
import { currentFile, stats, clearDownloads } from './torrent.js'
import { prowlarrStatus } from './prowlarr.js'
import fs from 'node:fs'
import { listDevices, refreshTvs, pickDevice, canResume, controlActive } from './tvs.js'
import * as player from './player.js'
import { findShows, getShow, cachedImage } from './shows.js'
import { findTeam, gameReport } from './sports.js'
import { startMediaServer } from './mediaserver.js'
import { SHORTCUTS, buildShortcut, bySlug, slug, macInstaller } from './shortcuts.js'

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
    // An NHL team ("Winnipeg Jets", "leafs game"): say whether it's on, the score, and the channels.
    if (!req.body?.link && !parsed.season) {
      const team = await findTeam(text).catch((err) => { console.error('[sports]', err.message); return null })
      if (team) {
        const report = await gameReport(team)
        console.log(`[sports] ${team.name}: ${report.speak}`)
        setStatus({ state: 'game', title: team.name, note: report.speak })
        return res.json({ ok: true, game: report.state, speak: report.speak })
      }
    }

    // Just a show's name: send back a link to the episode guide (or a picker when several shows
    // share the name, like the US, UK and Australian "The Traitors") instead of guessing an episode.
    if (!parsed.season && !req.body?.link && !req.body?.noGuide) {
      const shows = await findShows(parsed.title).catch((err) => { console.error('[shows]', err.message); return [] })
      if (shows.length) {
        const tvPart = tvName ? `&tv=${encodeURIComponent(tvName)}` : ''
        // Link back through whatever address the phone used (LAN, castbot.local or Tailscale).
        const host = req.get('host') || `${config.publicHost}:${config.port}`
        const guidePath = shows.length === 1
          ? `/show.html?id=${shows[0].id}${tvPart}`
          : `/pick.html?q=${encodeURIComponent(parsed.title)}${tvPart}`
        setStatus({ state: 'idle' })
        console.log(`[shows] "${parsed.title}": ${shows.length === 1 ? shows[0].name : `${shows.length} matches, sending the picker`}`)
        const speak = shows.length === 1
          ? `Pick an episode of ${shows[0].name} on your phone.`
          : `There are ${shows.length} shows called ${parsed.title}. Choose one on your phone.`
        return res.json({ ok: true, guide: true, url: `http://${host}${guidePath}`, guidePath, speak })
      }
    }

    // A known episode resumes mid-way.
    if (req.body?.variant) parsed.variant = String(req.body.variant).toUpperCase().slice(0, 8)
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
    console.log(`[tv] asked for "${tvName || '(none)'}" → "${tv}" (${device.kind})${exact ? '' : ' [fallback]'}`)
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

// Episode guide data: seasons/episodes from TVmaze plus what's been watched.
app.get('/api/show/:id', auth, async (req, res) => {
  try {
    const show = await getShow(req.params.id)
    if (!show) return res.status(404).json({ error: 'show not found' })
    // Same-named shows from different countries need telling apart when searching and in history.
    const norm = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '')
    const peers = (await findShows(show.name).catch(() => [])).filter((p) => norm(p.name) === norm(show.name))
    // The country tells same-named shows apart; if two share a country, the year does.
    const sameCountry = peers.filter((p) => p.country === show.country).length > 1
    const variant = peers.length < 2 ? null : sameCountry ? `${show.country || 'XX'}${show.year || ''}` : show.country
    res.json({ ...show, variant, watched: player.watchState(show.name, variant) })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Shows matching a name, for the picker.
app.get('/api/shows', async (req, res) => {
  try {
    res.json(await findShows(String(req.query.q || '')))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

app.get('/api/img', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=604800')
    res.sendFile(await cachedImage(String(req.query.u)))
  } catch {
    res.sendStatus(404)
  }
})

// Siri Shortcuts with this CastBot's address built in, and a Mac script that signs them all.
// Shortcuts use the castbot.local name so they survive the PC's IP changing.
const baseUrl = () => `http://${HOSTNAME}:${config.port}`
app.get('/shortcuts', (_req, res) => res.json(Object.entries(SHORTCUTS).map(([name, [about]]) => ({ name, about, file: `/shortcuts/${slug(name)}` }))))
app.get('/shortcuts/:slug', (req, res) => {
  const name = bySlug(req.params.slug)
  if (!name) return res.sendStatus(404)
  res.set('Content-Type', 'application/octet-stream')
  res.set('Content-Disposition', `attachment; filename="${name.replace(/'/g, '')}.shortcut"`)
  res.send(buildShortcut(name, baseUrl()))
})
app.get('/siri.sh', (_req, res) => res.type('text/plain').send(macInstaller(baseUrl())))
app.get('/api/address', (_req, res) => res.json({ base: baseUrl(), ip: `http://${config.publicHost}:${config.port}` }))

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

startMediaServer(app, express)

app.listen(config.port, '0.0.0.0', () => {
  console.log(`CastBot v${version} is running. Open http://localhost:${config.port} in Chrome`)
  console.log(`(from your phone: http://${HOSTNAME}:${config.port} or http://${config.publicHost}:${config.port})`)
  const others = lanAddresses().slice(1).map((a) => `${a.address} (${a.name})`)
  if (others.length) console.log(`(not used for TVs: ${others.join(', ')})`)
})
