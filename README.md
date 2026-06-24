# MediaSniff

A lightweight **cross-browser** extension that detects video/audio stream URLs (HLS, DASH, MP4, WebM, audio…) on any page and lets you copy them, open them, or generate ready-to-run **yt-dlp / ffmpeg** download commands.

Works on **Chrome, Edge, Brave, Opera, Vivaldi and Firefox** (Manifest V3).

## Features

- Sniffs media requests live via the `webRequest` API; a per-tab toolbar badge shows the count.
- Color-coded type detection: `HLS`, `DASH`, `MP4`, `WEBM`, `AUDIO`, `TS`, `MEDIA`.
- Filter by type + free-text search.
- Per-URL actions: **Copy** URL, **Cmd** (copy a download command), **DM** (send to AB Download Manager), **Open** in a new tab.
- **Send to AB Download Manager** — the **DM** button hands the URL + captured `Referer`/`User-Agent` to a running [ABDM](https://github.com/amir1376/ab-download-manager) instance via its local REST API (`http://localhost:15151/add`), for fast segmented downloads outside the browser.
- yt-dlp / ffmpeg command generator — picks sensible flags per media type, and remembers your tool choice across sessions.
- Captures each stream's `Referer` / `User-Agent` and bakes them into the generated commands, so protected streams that 403 without headers still download.
- Bulk actions: **Copy all URLs**, **Copy all cmds**, and **Export** to `.txt`, `.json`, or `.m3u` (a playlist you can open straight in VLC).

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
