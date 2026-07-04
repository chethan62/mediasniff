# MediaSniff

A lightweight **cross-browser** extension that detects video/audio stream URLs (HLS, DASH, MP4, WebM, audio…) on any page and lets you copy them, open them, or download with one click via **vsd** (Rust) → **N_m3u8DL-RE** → **yt-dlp** → **ffmpeg**.

Works on **Chrome, Edge, Brave, Opera, Vivaldi and Firefox** (Manifest V3).

## Install — one command

**Linux** (any systemd distro):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/chethan62/mediasniff/main/bootstrap.sh)
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/chethan62/mediasniff/main/bootstrap.ps1 | iex
```

Clones the repo, installs **[vsd](https://github.com/chethan62/vsd)** (Rust, 27 MB binary) + checks deps, and sets up the Grab helper to autostart. Falls back to N_m3u8DL-RE → yt-dlp → ffmpeg. The only thing left is loading the unpacked extension — it prints the exact step at the end. (Set `MEDIASNIFF_DIR` to choose the clone location.)

## Self-healing

If anything breaks (deleted files, missing tools, dead service), run:

```bash
./mediasniff-check.sh
```

It restores the repo from GitHub, rebuilds the extension, installs missing binaries (vsd, yt-dlp), fixes the systemd service path, restarts the grabber, and runs a health + download test. Alias: `mediasniff-check`.

## Features

### Stream detection
- Sniffs media requests live via `webRequest` API; per-tab toolbar badge shows count
- Filters out segments (`.ts`/`.m4s`/`init`), ad/cookie-sync/`?error=` URLs — you see manifests, not fragments
- Color-coded types: `HLS`, `DASH`, `MP4`, `WEBM`, `AUDIO`, `TS`, `MKV`, `AVI`, `MOV`, `WAV`, `SRT`, `VTT`, `ASS`
- Type emoji icons (🎬🎵💬📦📄) on every row
- Filter by type + free-text search

### Manifest parsing
- **HLS master playlists** — auto-parsed into collapsible variant rows showing resolution, bitrate, codec
- **DASH MPD manifests** — auto-parsed with AdaptationSet detection (audio vs video tracks)
- Correct combined / audio-only / video-only variant detection
- File size display via Content-Length capture

### Download (Grab)
- **One-click Grab** — POSTs URL + headers to local grabber helper
- Engine priority: **vsd** (Rust, 5ms startup) → **N_m3u8DL-RE** (C#) → **yt-dlp** → **ffmpeg**
- vsd auto-merges separate audio/video tracks into one file
- **Cookie capture** — Cookie header captured + passed to all downloaders for authenticated streams
- **Resume support** — `--enable-resume` for N_m3u8DL-RE
- **Retry endpoint** — `POST /retry/<id>` to retry failed downloads
- **Browser notification** on completion
- Live progress (`34%` → `Done✓` / `Failed✗`)
- Downloads panel lists active jobs
- Quality picker (Best/≤1080p/≤720p/≤480p/Worst) + Subs toggle
- **Grab All** — batch download every detected URL
- Saves to `~/Downloads`

### Other actions
- **Copy** URL, **Cmd** (copy download command), **DM** (send to AB Download Manager), **Open** in new tab
- **Cookie + Referer + User-Agent** baked into generated commands for protected streams
- Bulk: Copy all URLs, Copy all cmds, Export to `.txt` / `.json` / `.m3u` (opens in VLC)
- Remembers tool choice across sessions

## Quick install (Linux)

```bash
bash install.sh        # or:  npm run setup
```

Installs vsd + N_m3u8DL-RE, builds the extension, and registers the Grab helper as an autostart systemd user service. Idempotent — safe to re-run.

Then load the unpacked extension (the one manual step):
**Chromium / Vivaldi** → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder.

Works on any **systemd Linux** (Debian/Ubuntu, Fedora, Arch, openSUSE, …). Needs `python3` + `curl`; `ffmpeg`/`yt-dlp` recommended.

Manage the helper:
```bash
systemctl --user {status,restart,stop} mediasniff-grabber
```

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Installs N_m3u8DL-RE (win-x64), checks yt-dlp/ffmpeg, registers Grab helper as a Scheduled Task. Then load unpacked extension.

## Install (unpacked)

Chromium and Firefox require opposite MV3 background formats — two manifests:
`manifest.json` (Chromium — service worker) and `manifest.firefox.json` (Firefox — `background.scripts`).

### Chromium (Chrome / Edge / Brave / Opera / Vivaldi)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

### Firefox
1. `npm run build` — creates `dist/firefox/`
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on** → select `dist/firefox/manifest.json`
   - …or: `npx web-ext run --source-dir dist/firefox`
4. Signed XPI: download from [releases](https://github.com/chethan62/mediasniff/releases)

## Build

```bash
npm run build
```

Outputs:
- `dist/chrome/` + `mediasniff-chrome-<ver>.zip` — Chromium / Chrome Web Store
- `dist/firefox/` + `mediasniff-firefox-<ver>.zip` — Firefox / AMO

## Usage

1. Open a page that plays/loads media
2. Click the MediaSniff toolbar icon
3. Use **Copy / Cmd / Grab / DM / Open** on any row
4. Footer buttons for bulk copy/export

## Download engine fallback

```
vsd (Rust, 27 MB)       → primary: fast startup, machine-readable progress
  ↓ (fallback)
N_m3u8DL-RE (C#, .NET)  → robust HLS/DASH, resume, ad filtering
  ↓ (fallback)
yt-dlp (Python)          → universal: YouTube, 1000+ sites
  ↓ (fallback)
ffmpeg (C)               → direct remux/copy
```

All engines receive captured Cookie + Referer + User-Agent headers.

## Permissions

| Permission | Why |
|---|---|
| `webRequest` + `<all_urls>` | observe media response URLs + capture Referer/User-Agent/Cookie |
| `tabs` | scope results per tab and open URLs |
| `storage` | remember tool choice; persist results across background restarts |
| `notifications` | download completion notifications |
| `clipboardWrite` | copy buttons |

## Tests

```bash
npm test
# or: node tests/media.test.js && node tests/integration.test.js
```

- `tests/media.test.js` — detection, labelling, command generation, shell-quoting safety, exports
- `tests/integration.test.js` — full capture → detect → persist → command pipeline

## CI

GitHub Actions runs `npm test` + `npm run build` on every push and PR (`.github/workflows/ci.yml`).

## Self-healing

```bash
./mediasniff-check.sh
```

Restores repo, rebuilds, installs missing tools, fixes service, runs health check + test download.

## Credits

HLS/DASH download powered by:
- **[vsd](https://github.com/chethan62/vsd)** — Rust stream downloader (fork of [clitic/vsd](https://github.com/clitic/vsd))
- **[N_m3u8DL-RE](https://github.com/chethan62/N_m3u8DL-RE)** — C# stream downloader (fork of [nilaoda/N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE))
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — universal video downloader
- **[ffmpeg](https://ffmpeg.org)** — media muxing/transcoding

## License

MIT © 2026 chethan62
