// Cross-browser namespace: Firefox exposes `browser` (promises),
// Chromium (Chrome/Edge/Brave/Opera/Vivaldi) exposes `chrome` (promises in MV3).
const browser = globalThis.browser ?? globalThis.chrome;

const MEDIA_EXTS = [
  ".m3u8", ".mpd", ".mp4", ".mp3", ".webm",
  ".mkv", ".ogg", ".opus", ".flac", ".aac",
  ".ts", ".m4a", ".m4v", ".avi", ".mov"
];

const MEDIA_TYPES = [
  "video/", "audio/",
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
  "application/octet-stream"
];

const SKIP_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|css|js)(\?|$)/i,
  /\/ads?\//i,
  /doubleclick/i,
  /googlesyndication/i,
  /analytics/i,
  /tracking/i
];

// In-memory working set, mirrored to storage.session so per-tab media
// survives service-worker eviction on Chromium (worker is killed after
// ~30s idle, which would otherwise leave the popup empty).
const mediaByTab = {};
let hydrated = false;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const all = await browser.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("media_")) mediaByTab[k.slice(6)] = v;
    }
  } catch (e) {
    // storage.session unavailable -> degrade gracefully to memory-only
  }
}

function persist(tabId) {
  try {
    browser.storage.session.set({ ["media_" + tabId]: mediaByTab[tabId] || [] });
  } catch (e) { /* ignore */ }
}

function unpersist(tabId) {
  try {
    browser.storage.session.remove("media_" + tabId);
  } catch (e) { /* ignore */ }
}

function isMediaUrl(url, contentType) {
  if (SKIP_PATTERNS.some(p => p.test(url))) return false;
  const urlLower = url.toLowerCase().split("?")[0];
  if (MEDIA_EXTS.some(ext => urlLower.endsWith(ext))) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (MEDIA_TYPES.some(t => ct.startsWith(t))) return true;
  }
  return false;
}

function labelUrl(url) {
  const u = url.toLowerCase().split("?")[0];
  if (u.includes(".m3u8")) return "HLS";
  if (u.includes(".mpd")) return "DASH";
  if (u.includes(".mp4") || u.includes(".m4v")) return "MP4";
  if (u.includes(".mp3") || u.includes(".m4a") || u.includes(".aac") || u.includes(".flac") || u.includes(".opus")) return "AUDIO";
  if (u.includes(".webm")) return "WEBM";
  if (u.includes(".ts")) return "TS segment";
  return "MEDIA";
}

function setBadge(tabId) {
  const n = (mediaByTab[tabId] || []).length;
  browser.action.setBadgeText({ text: n ? String(n) : "", tabId: Number(tabId) });
  if (n) browser.action.setBadgeBackgroundColor({ color: "#534AB7", tabId: Number(tabId) });
}

browser.webRequest.onResponseStarted.addListener(
  async (details) => {
    const { tabId, url, responseHeaders, timeStamp } = details;
    if (tabId < 0) return;

    const ctHeader = (responseHeaders || []).find(
      h => h.name.toLowerCase() === "content-type"
    );
    const contentType = ctHeader ? ctHeader.value : "";

    if (!isMediaUrl(url, contentType)) return;

    await hydrate();

    if (!mediaByTab[tabId]) mediaByTab[tabId] = [];
    if (mediaByTab[tabId].some(e => e.url === url)) return;

    mediaByTab[tabId].push({
      url,
      label: labelUrl(url),
      contentType: contentType || "unknown",
      ts: timeStamp
    });

    persist(tabId);
    setBadge(tabId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => {
  delete mediaByTab[tabId];
  unpersist(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    delete mediaByTab[tabId];
    unpersist(tabId);
    browser.action.setBadgeText({ text: "", tabId });
  }
});

// sendResponse + `return true` keeps the message channel open for the async
// reply and works on both Chromium and Firefox (returning a Promise does not
// work on Chromium).
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_MEDIA") {
    hydrate().then(() => sendResponse({ urls: mediaByTab[msg.tabId] || [] }));
    return true;
  }
  if (msg.type === "CLEAR_MEDIA") {
    delete mediaByTab[msg.tabId];
    unpersist(msg.tabId);
    browser.action.setBadgeText({ text: "", tabId: msg.tabId });
    sendResponse({ ok: true });
    return true;
  }
});
