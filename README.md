# Space Cadet Web

3D Pinball: Space Cadet in the browser, packaged as one small Docker image.

The engine is [SpaceCadetPinball](https://github.com/k4zmu2a/SpaceCadetPinball), the full decompilation of the Windows game, compiled to WebAssembly. Unlike earlier web ports, the browser drives it: every displayed frame runs the physics in even sub-steps locked to your monitor's refresh, so the ball moves exactly once per vsync on 60, 120 or 144 Hz screens with no judder.

## Quick start

```sh
mkdir -p gamedata config
cp -r "/path/to/Pinball/." gamedata/     # your copy of the game files
docker compose up -d --build
```

Open <http://localhost:8080>. The home screen runs the table's own attract mode behind the menu; press **Enter** to play.

The first build compiles the engine and front end (a few minutes). The result is a ~50 MB `FROM scratch` image: one static Go binary plus the site.

### Game data

The game's art and sounds are not included. Use your own copy:

| Edition | Folder | Files |
| --- | --- | --- |
| 3D Pinball for Windows (XP and earlier) | `C:\Program Files\Windows NT\Pinball` | `PINBALL.DAT`, `*.WAV`, `PINBALL.MID` |
| Full Tilt! Pinball | the `CADET` folder on the CD | `CADET.DAT`, `SOUND\` |

Put either or both anywhere under the folder mounted at `/data` (subfolders are fine); each becomes a table you can pick on the home screen. Without a server-side folder, players can import the files in the browser instead (folder, ZIP or loose files); they are kept in that browser's storage.

For the music exactly as Windows played it, also copy `C:\Windows\System32\drivers\gm.dls` into the data folder. Otherwise music plays through the bundled GeneralUser GS SoundFont.

## Controls

| Key | Action |
| --- | --- |
| Left Shift | Left flipper |
| Right Shift | Right flipper |
| Space (hold, release) | Launch ball |
| T | Tilt (bump the table from below) |
| Esc | Pause menu: resume, restart game, settings, quit to home |

The original keys still work as alternates (Z, /, X, ., arrow keys), and F2–F8 keep their Windows meanings: F2 new game, F3 pause, F4 full screen, F5 effects, F6 music, F8 settings. Everything is rebindable in **Settings → Controls**, with up to three keys per action.

Also supported:

- **Mouse**: left and right click flip, middle click launches, side buttons bump the table (as in the original).
- **Gamepads**: bumpers or triggers flip, A launches, Y or D-pad up tilts, D-pad left/right bump, Start pauses. Rumble on bumps and tilts.
- **Touch**: tap the left or right half to flip, hold Launch for the plunger, a Tilt button, and haptics. Phones get a stacked layout with the table on top.
- **Cheats**: the table's own codes (`hidden test`, `rmax`, …) work. Games with cheats don't post high scores, as in the original.

Windows tip: pressing Shift five times opens the Sticky Keys prompt. Turn off its shortcut in Settings → Accessibility → Keyboard before a long session.

## What's in it

- **Frame pacing**: requestAnimationFrame-driven, with each frame split into equal physics steps of at most 1/240 s (adjustable: 120, 240 or 480 per second). Only the rectangle of the screen that changed is uploaded to the GPU.
- **Picture**: WebGL2 renderer with Sharp (crisp pixels at any size, the default), Smooth, Pixel and CRT filters; side-by-side or stacked layouts (auto-picked, good for portrait monitors and phones); optional whole-number scaling; the table shakes independently of the score panel when nudged, like the original.
- **Sound**: effects go straight to WebAudio buffer sources, so there is no main-thread mixing and no crackle on a slow frame, with stereo placement by where on the table each sound happens. MIDI music runs in a SoundFont synthesizer on the audio thread ([SpessaSynth](https://github.com/spessasus/spessasynth_lib)); the bundled bank is converted to SF3 at build time (32 MB → 9 MB) and only downloads when music first plays.
- **High scores**: a shared "house" leaderboard on the server (`/config/scores.json`) plus a per-browser list. The table's own in-game high-score roll is fed from the house list.
- **Tilt meter**: an optional gauge beside the table showing how close your nudging is to a tilt.
- **Installable and offline**: a service worker caches the app, engine and game data after the first visit (needs HTTPS, e.g. behind your reverse proxy).
- **Pauses itself** when the tab is hidden or the window loses focus, and keeps the screen awake while you play. In full screen on Chromium browsers, Esc reaches the game (hold Esc to leave full screen).

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` | Game data (read-only is fine) |
| `STATE_DIR` | `/config` | Leaderboard storage |
| `PUID` / `PGID` | `1000` / `1000` | User the server drops to after making `/config` writable. Unraid: `99` / `100` |
| `LEADERBOARD` | `true` | Shared high scores |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the score rate limit (set behind a reverse proxy) |
| `LOG_REQUESTS` | `false` | Access log |

Build arguments: `SOUNDFONT_URL` (empty to ship no SoundFont), `EMSDK_VERSION` (pinned to 3.1.52), `SCP_COMMIT` (upstream engine commit), `VERSION`.

### Unraid and reverse proxies

`unraid/spacecadet.xml` is a container template (port 8088, paths under `/mnt/user/appdata/spacecadet`, PUID 99/PGID 100). It points at `ghcr.io/au12/spacecadet-web`, which the included GitHub Actions workflow publishes when the repository is pushed to GitHub; adjust the owner if yours differs.

Behind Nginx Proxy Manager no special settings are needed (no WebSockets). Set `TRUST_PROXY=true` so the leaderboard's rate limit sees real client addresses.

## How it works

```
browser                                         container
┌──────────────────────────────────────┐       ┌──────────────────────────────┐
│ app.js       state, menus, settings  │       │ spacecadet (Go, static)      │
│ input.js     keys/mouse/pad/touch ───┼─┐     │  /           site, br/gzip   │
│ renderer.js  WebGL2, filters, layout │ │     │  /api/tables  scans /data    │
│ audio.js     WebAudio SFX + music    │ │     │  /data/…      game files     │
│      ▲ Module.scpAudio               │ │     │  /api/scores  leaderboard    │
│ pinball.wasm  (engine, no main loop) ◄─┘     └──────────────────────────────┘
│   scp_tick(ms) per rAF → BGRA frame  │
└──────────────────────────────────────┘
```

- `engine/patches/0001-web-port.patch` is a small, `#ifdef SCP_WEB`-guarded patch to the upstream engine: skip repaints on intermediate physics steps, track the changed screen rectangle, hand game over to the page.
- `engine/web/` holds the web entry points (`web_main.cpp`) and an SDL_mixer-compatible shim (`web_mixer.*`) that forwards the engine's audio calls to WebAudio, so `Sound.cpp` and `midi.cpp` run unmodified.
- `web/` is the front end (vanilla JS, bundled with esbuild, every asset content-hashed and precompressed).
- `server/` is the Go server (standard library only).

### Developing without Docker

```sh
# engine (needs emsdk 3.1.52 on PATH)
git clone https://github.com/k4zmu2a/SpaceCadetPinball && cd SpaceCadetPinball
git checkout cb9b7b886244a27773f66b0b19fdc2998392565e
cp -r ../engine/web Platform/Web && git apply ../engine/patches/*.patch
emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
cp bin/pinball.* ../web/engine-dist/

# front end
cd ../web && npm ci && SOUNDFONT_FILE=/path/to/bank.sf2 npm run build

# server
cd ../server && go run . # with WEB_ROOT=../web/dist DATA_DIR=../gamedata STATE_DIR=../config PUID=0
```

## Credits

- Engine: [SpaceCadetPinball](https://github.com/k4zmu2a/SpaceCadetPinball) by Andrey Muzychenko and contributors (MIT).
- Music synthesis: [SpessaSynth](https://github.com/spessasus/spessasynth_lib) (Apache 2.0). SoundFont: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) by S. Christian Collins.
- Fonts: Pixelify Sans and Chakra Petch (SIL Open Font License).
- 3D Pinball: Space Cadet © Microsoft, Maxis and Cinematronics. This project ships none of the game's data.

License texts for everything bundled are served at `/licenses/`.
