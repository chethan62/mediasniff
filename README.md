# MediaSniff

A lightweight **cross-browser** extension that detects video/audio stream URLs (HLS, DASH, MP4, WebM, audio…) on any page and lets you copy them, open them, or generate ready-to-run **yt-dlp / ffmpeg** download commands.

Works on **Chrome, Edge, Brave, Opera, Vivaldi and Firefox** (Manifest V3).

## Features

- Sniffs media requests live via the `webRequest` API; a per-tab toolbar badge shows the count.
- Color-coded type detection: `HLS`, `DASH`, `MP4`, `WEBM`, `AUDIO`, `TS`, `MEDIA`.
- Filter by type + free-text search.
- Per-URL actions: **Copy** URL, **Cmd** (copy a download command), **Open** in a new tab.
- yt-dlp / ffmpeg command generator — picks sensible flags per media type, and remembers your tool choice across sessions.
- Bulk actions: **Copy all URLs**, **Copy all cmds**, and **Export** to `.txt`, `.json`, or `.m3u` (a playlist you can open straight in VLC).

## Install (unpacked)

### Chromium (Chrome / Edge / Brave / Opera / Vivaldi)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

> Chrome may show a harmless *"Unrecognized manifest key 'background.scripts'"* warning — Chromium uses the service worker, Firefox uses the event page. Both run the same `background.js`.

### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → select `manifest.json`
3. If prompted, grant the all-sites host permission from the extension's menu.

## Usage

Open a page that plays/loads media, then click the MediaSniff toolbar icon. Use **Copy / Cmd / Open** on any row, or the footer buttons for bulk copy/export. The `.m3u` export opens directly in VLC to play or grab every stream at once.

## Permissions

| Permission | Why |
|---|---|
| `webRequest` + `<all_urls>` | observe media response URLs |
| `tabs` | scope results per tab and open URLs |
| `storage` | remember the chosen tool; survive service-worker eviction |
| `clipboardWrite` | copy buttons |

## License

MIT © 2026 chethan62
