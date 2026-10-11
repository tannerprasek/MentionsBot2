# CastBot

Say "Hey Siri, CastBot", tell it what to watch and which TV. A server on your home network searches your indexers, picks the best torrent, and streams it to that Chromecast while it downloads.

```
Siri Shortcut ──POST /play──▶ CastBot server ──Torznab──▶ Prowlarr / Jackett
                                   │
                                   ├─ WebTorrent (downloads in sequence, serves HTTP with Range support)
                                   └─ Chromecast (mDNS discovery, Default Media Receiver)
```

## Quick start (no Terminal)

1. Install [Node.js](https://nodejs.org/en/download) and [Prowlarr](https://prowlarr.com) on a computer that's on the same Wi-Fi as your TVs. In Prowlarr, add your indexers.
2. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click **Start CastBot.command** (Mac) or **Start CastBot.bat** (Windows). Chrome opens the CastBot page.
4. CastBot finds Prowlarr on its own. The line under the search buttons lists the indexers it will search.
5. Type a movie or show, pick a TV, and click **▶ Play best match**.

On a Mac, the first time, right-click **Start CastBot.command** → **Open** if macOS blocks it.

From your phone, open the second address the launcher window prints (`http://192.168.x.x:8787`).

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
2. **Choose from Menu**. Prompt: "Which TV?" Add one item per TV, using the names from `/devices` (e.g. "Living Room TV", "Bedroom TV"). Inside each item, add a **Text** action containing that TV's name.
3. **Get Contents of URL**
   - URL: `http://<server-lan-ip>:8787/play`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer <your API_TOKEN>`
   - Request Body: JSON, with `title` = *Provided Input* and `tv` = *Menu Result*
4. **Get Dictionary Value**: key `speak` from *Contents of URL*
5. **Speak Text**: *Dictionary Value*

Then say: "Hey Siri, CastBot" → "Breaking Bad season 2 episode 3" → "Bedroom TV".

If you only have one TV, skip step 2 and set `DEFAULT_TV`.

Add more shortcuts the same way for **CastBot Stop** (`POST /stop`), **CastBot Pause** (`POST /control/pause`), and **CastBot Resume** (`POST /control/resume`).

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

| TV | Torrent playback | Opens Netflix / Disney+ / Apple TV |
|---|---|---|
| Chromecast / Google TV / Google Cast TVs | Google Cast | Samsung only |
| Roku (TCL, Hisense, sticks) | Roku's "Play on Roku" channel | Roku apps |
| LG webOS | DLNA (LG's media player) | LG apps |

A Roku or LG that also has Chromecast built in is listed once: torrents play over Google Cast (falling back to the Roku/LG player if Cast fails), and apps open through Roku/LG. If a Roku refuses commands, set Settings → System → Advanced system settings → Control by mobile apps → Network access to **Permissive**. Roku has no exact seek, so ⟲ 30s uses Instant Replay and 30s ⟳ scrubs forward.

## Streaming services first

Before searching torrents, CastBot checks JustWatch's catalog for whether the title is on Netflix, Disney+ or Apple TV+ (choose which in Settings). If it is:

- **Samsung, LG and Roku TVs:** CastBot opens that service's app on the TV. The first time, Samsung and LG TVs show an **Allow** prompt for CastBot; accept it once. CastBot asks the app to go straight to the title, but some apps only open their home screen.
- **Other TVs:** Siri and the page tell you which service has it.

A Samsung Frame in Art Mode is switched to TV mode first (over its Art Mode API, or a Power press if the TV ignores that), both before opening an app and before casting.

To torrent anyway, click **Play via torrent instead**, or start the request with "torrent", e.g. "torrent Stranger Things".

## Release selection

Results with fewer than `MIN_SEEDERS` seeders, larger than `MAX_SIZE_GB`, CAM/TS rips, HEVC/x265 (when `AVOID_HEVC=true`), or 4K (unless `ALLOW_4K=true`) are dropped. The rest are ranked by seeders, a `PREFERRED_QUALITY` match, WEB-DL/BluRay sources, and MP4 files.

## Notes

- The Default Media Receiver plays H.264 video in MP4 or MKV. HEVC and some audio codecs (DTS, TrueHD) won't play, which is why HEVC is filtered out. A Chromecast with Google TV handles more formats.
- Playback starts once enough of the file has downloaded. Seeking ahead makes WebTorrent fetch that part first.
- Downloads are temporary. They're deleted when you press Stop or play something else, when a Chromecast reports the video finished, after `IDLE_HOURS` (default 2) with nothing streamed, and on every start.
- `npm test` runs the query-parser tests.
