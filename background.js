// Load shared pure logic. Chromium service worker: importScripts (synchronous).
// Firefox event page provides it via the manifest "background.scripts" array,
// where importScripts is undefined — so this guard simply no-ops there.
try {
  if (typeof importScripts === "function") importScripts("lib/media.js");
} catch (e) { /* already loaded via the scripts array */ }

// Cross-browser namespace: Firefox `browser` (promises),
// Chromium (Chrome/Edge/Brave/Opera/Vivaldi) `chrome` (promises in MV3).
const browser = globalThis.browser ?? globalThis.chrome;

// isMediaUrl, labelUrl, MAX_PER_TAB come from lib/media.js (global scope).

// In-memory working set, mirrored to storage.session so per-tab media
// survives service-worker eviction on Chromium.
const mediaByTab = {};
// Captured request headers (Referer / User-Agent) keyed by `${tabId}\n${url}`,
// so the popup can bake them into yt-dlp/ffmpeg commands. In-memory only.
const headersByReq = {};
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

function clearTabHeaders(tabId) {
  const prefix = tabId + "\n";
  for (const k of Object.keys(headersByReq)) {
    if (k.startsWith(prefix)) delete headersByReq[k];
  }
}

function setBadge(tabId) {
  const n = (mediaByTab[tabId] || []).length;
  browser.action.setBadgeText({ text: n ? String(n) : "", tabId: Number(tabId) });
  if (n) browser.action.setBadgeBackgroundColor({ color: "#534AB7", tabId: Number(tabId) });
}

// --- Capture Referer / User-Agent for media requests so external downloads
// (yt-dlp/ffmpeg) work on streams that 403 without them. ---
function recordHeaders(details) {
  const { tabId, url, requestHeaders } = details;
  if (tabId < 0 || !requestHeaders) return;
  if (!isMediaUrl(url, "")) return;                         // extension-based prefilter
  if (Object.keys(headersByReq).length > 2000) return;      // defensive cap
  let referer = "";
  let userAgent = "";
  for (const h of requestHeaders) {
    const n = h.name.toLowerCase();
    if (n === "referer") referer = h.value || "";
    else if (n === "user-agent") userAgent = h.value || "";
  }
  if (referer || userAgent) headersByReq[tabId + "\n" + url] = { referer, userAgent };
}

try {
  // Chrome needs "extraHeaders" to expose Referer/User-Agent.
  browser.webRequest.onSendHeaders.addListener(
    recordHeaders,
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
  );
} catch (e) {
  // Firefox rejects "extraHeaders" -> retry without it.
  try {
    browser.webRequest.onSendHeaders.addListener(
      recordHeaders,
      { urls: ["<all_urls>"] },
      ["requestHeaders"]
    );
  } catch (e2) { /* header capture unavailable */ }
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
    if (mediaByTab[tabId].length >= MAX_PER_TAB) return;     // bound per-tab growth

    const hk = tabId + "\n" + url;
    const hdr = headersByReq[hk] || {};

    mediaByTab[tabId].push({
      url,
      label: labelUrl(url),
      contentType: contentType || "unknown",
      ts: timeStamp,
      referer: hdr.referer || "",
      userAgent: hdr.userAgent || ""
    });
    delete headersByReq[hk];

    persist(tabId);
    setBadge(tabId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => {
  delete mediaByTab[tabId];
  unpersist(tabId);
  clearTabHeaders(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    delete mediaByTab[tabId];
    unpersist(tabId);
    clearTabHeaders(tabId);
    browser.action.setBadgeText({ text: "", tabId });
  }
});

// sendResponse + `return true` keeps the channel open for the async reply and
// works on both Chromium and Firefox (returning a Promise does not on Chromium).
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_MEDIA") {
    hydrate().then(() => sendResponse({ urls: mediaByTab[msg.tabId] || [] }));
    return true;
  }
  if (msg.type === "CLEAR_MEDIA") {
    delete mediaByTab[msg.tabId];
    unpersist(msg.tabId);
    clearTabHeaders(msg.tabId);
    browser.action.setBadgeText({ text: "", tabId: msg.tabId });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "SEND_TO_ABDM") {
    fetch(ABDM_ADD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload)
    })
      .then(r => sendResponse({ ok: r.ok, status: r.status }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "SEND_TO_GRABBER") {
    fetch(GRABBER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.payload)
    })
      .then(r => r.json().then(j => sendResponse({ ok: r.ok, status: r.status, id: j.id })))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "GET_JOBS") {
    fetch(GRABBER_JOBS_URL)
      .then(r => r.json().then(j => sendResponse({ ok: r.ok, jobs: j.jobs })))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg.type === "GET_JOB_STATUS") {
    fetch(GRABBER_STATUS_URL + encodeURIComponent(msg.id))
      .then(r => r.json().then(j => sendResponse({ ok: r.ok, ...j })))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
