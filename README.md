# MediaSniff

A lightweight **cross-browser** extension that detects video/audio stream URLs (HLS, DASH, MP4, WebM, audio…) on any page and lets you copy them, open them, or generate ready-to-run **yt-dlp / ffmpeg** download commands.

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

Clones the repo, installs the HLS engine (**N_m3u8DL-RE**) + checks deps, and sets up the Grab
helper to autostart. The only thing left is loading the unpacked extension — it prints the exact
step at the end. (Set `MEDIASNIFF_DIR` to choose the clone location.)

## Features

- Sniffs media requests live via the `webRequest` API; a per-tab toolbar badge shows the count.
- Color-coded type detection: `HLS`, `DASH`, `MP4`, `WEBM`, `AUDIO`, `TS`, `MEDIA`.
- Filter by type + free-text search.
- Per-URL actions: **Copy** URL, **Cmd** (copy a download command), **DM** (send to AB Download Manager), **Open** in a new tab.
- **Send to AB Download Manager** — the **DM** button hands the URL + captured `Referer`/`User-Agent` to a running [ABDM](https://github.com/amir1376/ab-download-manager) instance via its local REST API (`http://localhost:15151/add`), for fast segmented downloads outside the browser. *(Direct files only — ABDM can't assemble HLS.)*
- **Grab (one-click HLS/DASH download)** — the **Grab** button POSTs the URL + headers to a tiny local helper (`helper/grab.py`) that runs **N_m3u8DL-RE** for HLS/DASH (downloads every segment + merges separate video/audio — handles Dailymotion-style streams yt-dlp can't), falling back to yt-dlp/ffmpeg, all outside the browser, saving an `.mp4` to `~/Downloads`. Install N_m3u8DL-RE for robust HLS — the helper auto-detects it on PATH. Start the helper first:
  ```bash
  npm run helper        # or: python3 helper/grab.py  (listens on 127.0.0.1:15152)
  ```
  Click **Grab** on an HLS row right after sniffing (while the token is fresh) — yt-dlp resolves the variant ladder + muxes automatically. Needs `yt-dlp`/`ffmpeg` on PATH. The button shows **live progress** (%→Done✓/Failed✗), a **Downloads** panel lists active jobs, and the toolbar **Quality** picker (Best/≤1080p/≤720p/≤480p/Worst) + **Subs** toggle are applied.
- yt-dlp / ffmpeg command generator — picks sensible flags per media type, and remembers your tool choice across sessions.
- Captures each stream's `Referer` / `User-Agent` and bakes them into the generated commands, so protected streams that 403 without headers still download.
- Bulk actions: **Copy all URLs**, **Copy all cmds**, and **Export** to `.txt`, `.json`, or `.m3u` (a playlist you can open straight in VLC).

## Quick install (Linux)

One command installs the HLS engine (**N_m3u8DL-RE**), builds the extension, and
registers the Grab helper as an **autostart** systemd user service — so the whole
stack works after a single run (idempotent, safe to re-run):

```bash
bash install.sh        # or:  npm run setup
```

Then load the unpacked extension (the one manual step):
**Chromium / Vivaldi** → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder.

Works on any **systemd Linux** (Debian/Ubuntu, Fedora, Arch, openSUSE, …) — the installer
detects your package manager for dependency hints and picks the right N_m3u8DL-RE build
(x64/arm64, glibc/musl). Needs `python3` + `curl`; `ffmpeg`/`yt-dlp` recommended.
No user systemd (Void/OpenRC, minimal WSL, …)? It prints how to run the helper manually.
The helper autostarts on login — manage it with `systemctl --user status mediasniff-grabber`.

## Windows

The extension and helper are cross-platform. Run the PowerShell installer from the repo folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It installs **N_m3u8DL-RE** (win-x64) to `%LOCALAPPDATA%\Programs\mediasniff`, checks `yt-dlp`/`ffmpeg` (`winget install yt-dlp ffmpeg`), and registers the Grab helper as a **Scheduled Task** that autostarts at logon (windowless). Then load the unpacked extension — **Chrome** `chrome://extensions` / **Edge** `edge://extensions` → Developer mode → **Load unpacked** → this folder. (Chromium loads the repo root directly; Firefox-on-Windows needs `npm run build` via Git Bash/WSL.) ABDM has a Windows build for the DM button.

## Install (unpacked)

Chromium and Firefox require opposite MV3 background formats, so there are two manifests:
`manifest.json` (Chromium — service worker) and `manifest.firefox.json` (Firefox — `background.scripts`).
Run `npm run build` to produce a clean per-browser package under `dist/`.

### Chromium (Chrome / Edge / Brave / Opera / Vivaldi)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (uses `manifest.json` directly)

### Firefox
1. `npm run build` — creates `dist/firefox/` with the Firefox manifest
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on** → select `dist/firefox/manifest.json`
   - …or simply: `npx web-ext run --source-dir dist/firefox`

## Build

```bash
npm run build
```

Outputs into `dist/`:
- `dist/chrome/`  + `mediasniff-chrome-<ver>.zip`  — Chromium / Chrome Web Store
- `dist/firefox/` + `mediasniff-firefox-<ver>.zip` — Firefox / AMO

## Usage

Open a page that plays/loads media, then click the MediaSniff toolbar icon. Use **Copy / Cmd / Open** on any row, or the footer buttons for bulk copy/export. The `.m3u` export opens directly in VLC to play or grab every stream at once.

## Permissions

| Permission | Why |
|---|---|
| `webRequest` + `<all_urls>` | observe media response URLs + capture Referer/User-Agent |
| `tabs` | scope results per tab and open URLs |
| `storage` | remember the chosen tool; persist results across background restarts |
| `clipboardWrite` | copy buttons |

## Tests

The browser-independent logic lives in `lib/media.js` and is covered by a zero-dependency test suite (no `npm install` needed):

```bash
npm test
# or: node tests/media.test.js && node tests/integration.test.js
```

- `tests/media.test.js` — unit tests for detection, labelling, command generation (including shell-quoting safety) and the txt/json/m3u exports.
- `tests/integration.test.js` — loads the real `background.js` / `popup.js` against stubbed browser + DOM APIs and verifies the capture → detect → persist → command pipeline end to end.

## License

MIT © 2026 chethan62
