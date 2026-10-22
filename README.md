# CastBot

Say "Hey Siri, CastBot", tell it what to watch and which TV. A server on your home network searches your indexers, picks the best torrent, and streams it to that Chromecast while it downloads.

```
Siri Shortcut ──POST /play──▶ CastBot server ──Torznab──▶ Prowlarr / Jackett
                                   │
                                   ├─ WebTorrent (downloads in sequence, serves HTTP with Range support)
                                   └─ Chromecast (mDNS discovery, Default Media Receiver)
```

## Quick start

**Download:** https://github.com/tannerprasek/MentionsBot2/archive/refs/heads/claude/polymarket-mispricing-bot-01LWTtedp1AEAh3X33y5Gps2.zip

1. Install [Prowlarr](https://prowlarr.com) on a computer that's on the same Wi-Fi as your TVs, and add your indexers in it.
2. Unzip the download and double-click **Start CastBot.bat** (Windows) or **Start CastBot.command** (Mac).
   - No Node.js? The launcher downloads a private copy into the CastBot folder the first time.
   - Windows: if "Windows protected your PC" appears, click **More info → Run anyway**; if the firewall asks, allow **Private networks**.
   - Mac: if macOS blocks it, open **System Settings → Privacy & Security** and click **Open Anyway**.
3. Chrome opens CastBot. It finds Prowlarr and your TVs by itself; set a **Default TV** in **⚙ Settings**.
4. **Siri:** click **🎙 Set up Siri** on the CastBot page and follow it. On a Mac, one Terminal line downloads, signs and opens all six shortcuts (CastBot, Next, What's Playing, Pause, Resume, Stop) with your PC's address filled in. The **Siri Shortcuts** folder in the download has the same shortcuts (they ask for the address) and a **Sign and Add (Mac).command** helper.

Each start checks GitHub for updates and keeps your settings, history and downloads.

## Requirements

- An always-on machine on the same LAN as the TVs (Mac mini, Raspberry Pi 4/5, NAS, old laptop), with Node 20 or newer
- [Prowlarr](https://prowlarr.com) or [Jackett](https://github.com/Jackett/Jackett) with your indexers configured
- Chromecasts or Google TVs on the same network/VLAN, with mDNS not blocked

## Setup

```bash
npm install
cp .env.example .env   # fill in TORZNAB_URL, TORZNAB_API_KEY, API_TOKEN, DEFAULT_TV
npm start
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/devices   # lists the TVs it found
```

Torznab URL:
- **Prowlarr:** nothing to enter: with the URL left empty, CastBot reads the API key from the local Prowlarr install and searches all of its indexers. To use a single indexer instead, paste its Torznab feed URL, e.g. `http://localhost:9696/1/api`.
- **Jackett:** `http://localhost:9117/api/v2.0/indexers/all/results/torznab/api`. The API key is shown at the top of the dashboard.

To keep it running, use `pm2 start src/server.js --name castbot` or a systemd/launchd service.

## Siri Shortcut

Open the Shortcuts app on your iPhone, create a new shortcut, and name it **CastBot**. The name is what you say to Siri.

1. **Ask for Input** (Text). Prompt: "What do you want to watch?"
2. **Get Contents of URL**: `http://<server-lan-ip>:8787/tvs` (returns the TVs CastBot can see), then **Choose from List** with Prompt "Which TV?". Use **Chosen Item** as `tv` below.
3. **Get Contents of URL**
   - URL: `http://<server-lan-ip>:8787/play`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <your API_TOKEN>`
   - Request Body: JSON, with `title` = *Provided Input* and `tv` = *Chosen Item*
4. **Get Dictionary Value**: key `speak` from *Contents of URL*
5. **Speak Text**: *Dictionary Value*
6. **Get Dictionary Value**: key `url` from *Contents of URL*, then **If** *Dictionary Value* **has any value** → **Open URLs** *Dictionary Value* (opens the episode guide when you only named a show)

Then say: "Hey Siri, CastBot" → "Breaking Bad season 2 episode 3" → "Bedroom TV".

If you only have one TV, skip step 2 and set `DEFAULT_TV`.

Add more shortcuts the same way, each a **Get Contents of URL** followed by **Get Dictionary Value** `speak` and **Speak Text**:

| Shortcut | URL | Method |
|---|---|---|
| CastBot Next | `/next` | POST |
| What's Playing | `/now` | GET |
| CastBot Pause | `/control/pause` | POST |
| CastBot Resume | `/control/resume` | POST |
| CastBot Stop | `/stop` | POST |

**Away from home:** the phone has to reach the server. Install [Tailscale](https://tailscale.com) on the phone and the server, then use the server's Tailscale IP in the shortcut URL. The Chromecast still streams over your LAN.

## API

All endpoints except `/stream` need `Authorization: Bearer <API_TOKEN>` (or `?token=`).

| Method | Path | Body | |
|---|---|---|---|
| POST | `/play` | `{ "title": "dune part two", "tv": "Living Room" }` | Searches and replies right away with the chosen release; streaming starts in the background |
| POST | `/stop` | | Stops the cast and the torrent |
| POST | `/control/:action` | `{ "value": 30 }` | `pause`, `resume`, `seek` (seconds), `volume` (0–1) |
| GET | `/devices` | | Chromecasts found |
| GET | `/status` | | Current state, download progress, speed, peers |

Requests are parsed into queries: "season two episode 3" or "s2e3" becomes `S02E03`, and "season 1" becomes `S01` (a season pack; the matching episode file is chosen when an episode is given).

## Supported TVs

| TV | Torrent playback |
|---|---|
| Chromecast / Google TV / Google Cast TVs | Google Cast |
| Roku (TCL, Hisense, sticks) | Roku's "Play on Roku" channel |
| LG webOS | DLNA (LG's media player) |

A Roku or LG that also has Chromecast built in is listed once: torrents play over Google Cast (falling back to the Roku/LG player if Cast fails). A Roku without the "Play on Roku" channel (many TCL models) uses **Roku Media Player** instead: CastBot appears there as a media server named "CastBot", opens the player, and offers the video. Set `ROKU_KEYS` (e.g. `Down,Select,Select`) in `.env`, or `rokuKeys` in `settings.json`, to have it press those remote keys to reach CastBot; otherwise pick **CastBot** → the video once by hand. If a Roku refuses commands, set Settings → System → Advanced system settings → Control by mobile apps → Network access to **Permissive**. Roku has no exact seek, so ⟲ 30s uses Instant Replay and 30s ⟳ scrubs forward.

## Watching shows

- **Resume:** CastBot saves where you are every 10 seconds. Asking for the same movie or episode again picks up there (Chromecast and LG; Roku always starts from the beginning). Add "from the start" to skip that.
- **Episode guide:** asking for just a show's name ("Bluey") sends back a link to an episode guide: collapsible seasons, thumbnails, what you've watched, and a Continue button. If several shows share the name (the US, UK and Australian "The Traitors", or "Traitors" vs "The Traitors"), you first get a picker with posters, years, countries and networks. Tap an episode to play it on the chosen TV; torrents are searched for that country's version. Show data and thumbnails come from TVmaze and are cached in `cache/`.
- **Next episode:** "CastBot Next" (or ⏭ on the page) plays the following episode on the same TV. With **Play the next episode automatically** on in Settings, it starts by itself when an episode ends.
- **No waiting between episodes:** 10 minutes before an episode ends, the next one starts downloading in the background. If you're watching from a season pack, it's already there.
- **No early stalls:** CastBot downloads the start (or the resume point) and the end of the file before it starts the TV.

History is kept in `history.json` next to CastBot.

## NHL games

Ask for a team ("Winnipeg Jets", "Jets", "Leafs game", "is the Oilers game on") and CastBot answers from the NHL's public schedule: the live score and clock, today's start time, or the next game, plus the TV channels carrying it (Canada and US). Team names that are also titles ("Predators", "Wild", "Kings") need a hint like the city or "game".

## Release selection

Results with fewer than `MIN_SEEDERS` seeders, larger than `MAX_SIZE_GB`, CAM/TS rips, HEVC/x265 (when `AVOID_HEVC=true`), or 4K (unless `ALLOW_4K=true`) are dropped. The rest are ranked by seeders, a `PREFERRED_QUALITY` match, WEB-DL/BluRay sources, and MP4 files.

## Notes

- The Default Media Receiver plays H.264 video in MP4 or MKV. HEVC and some audio codecs (DTS, TrueHD) won't play, which is why HEVC is filtered out. A Chromecast with Google TV handles more formats.
- Playback starts once enough of the file has downloaded. Seeking ahead makes WebTorrent fetch that part first.
- Downloads are temporary. They're deleted when you press Stop or play something else, when a Chromecast reports the video finished, after `IDLE_HOURS` (default 2) with nothing streamed, and on every start.
- `npm test` runs the query-parser tests.
