// Cross-browser namespace shim (Chromium exposes only `chrome`).
const browser = globalThis.browser ?? globalThis.chrome;

// shortUrl, buildCommand, outExt, shq, sortMedia, exportContent, abdmPayload
// come from lib/media.js (loaded first in popup.html).

let allUrls = [];

function badgeClass(label) {
  const map = {
    "HLS": "badge-HLS",
    "DASH": "badge-DASH",
    "MP4": "badge-MP4",
    "AUDIO": "badge-AUDIO",
    "WEBM": "badge-WEBM",
    "TS segment": "badge-TS",
    "MEDIA": "badge-MEDIA"
  };
  return map[label] || "badge-MEDIA";
}

function currentTool() {
  const el = document.getElementById("tool-select");
  return el ? el.value : "yt-dlp";
}

// --- Clipboard with a hardened fallback so Copy can never silently fail. ---
function flash(btn) {
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("copied");
  }, 1400);
}

function fallbackCopy(text, btn) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
    flash(btn);
  } catch (e) { /* clipboard unavailable */ }
}

function copyText(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(btn)).catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
}

// --- Send a media URL (+ captured headers) to AB Download Manager. ---
function finishAbdm(btn, orig, ok) {
  btn.textContent = ok ? "Sent!" : "ABDM?";
  btn.title = ok ? "Sent to AB Download Manager" : "Couldn't reach AB Download Manager (is it running?)";
  btn.classList.add(ok ? "copied" : "fail");
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("copied", "fail");
    btn.disabled = false;
  }, 1700);
}

function sendToAbdm(entry, btn) {
  const orig = btn.textContent;
  btn.textContent = "…";
  btn.disabled = true;
  browser.runtime.sendMessage({ type: "SEND_TO_ABDM", payload: abdmPayload(entry) })
    .then(res => finishAbdm(btn, orig, !!(res && res.ok)))
    .catch(() => finishAbdm(btn, orig, false));
}

function downloadBlob(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportList(list, fmt) {
  if (!list.length) return;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = fmt === "json" ? "json" : fmt === "m3u" ? "m3u" : "txt";
  const mime = fmt === "json" ? "application/json" : fmt === "m3u" ? "audio/x-mpegurl" : "text/plain";
  downloadBlob(`mediasniff-${stamp}.${ext}`, exportContent(list, fmt), mime);
}

function buildItem(entry) {
  const li = document.createElement("li");
  li.className = "url-item";

  const badge = document.createElement("span");
  badge.className = "badge " + badgeClass(entry.label);
  badge.textContent = entry.label;

  const urlSpan = document.createElement("span");
  urlSpan.className = "url-text";
  urlSpan.textContent = shortUrl(entry.url);
  urlSpan.title = entry.url;

  const actions = document.createElement("div");
  actions.className = "url-actions";

  const btnCopy = document.createElement("button");
  btnCopy.className = "btn-copy";
  btnCopy.textContent = "Copy";
  btnCopy.onclick = () => copyText(entry.url, btnCopy);

  const btnCmd = document.createElement("button");
  btnCmd.className = "btn-cmd";
  btnCmd.textContent = "Cmd";
  btnCmd.title = (entry.referer || entry.userAgent)
    ? "Copy download command (includes captured Referer/User-Agent)"
    : "Copy download command";
  btnCmd.onclick = () => copyText(buildCommand(entry, currentTool()), btnCmd);

  const btnDm = document.createElement("button");
  btnDm.className = "btn-dm";
  btnDm.textContent = "DM";
  btnDm.title = "Send to AB Download Manager";
  btnDm.onclick = () => sendToAbdm(entry, btnDm);

  const btnOpen = document.createElement("button");
  btnOpen.className = "btn-open";
  btnOpen.textContent = "Open";
  btnOpen.onclick = () => browser.tabs.create({ url: entry.url });

  actions.appendChild(btnCopy);
  actions.appendChild(btnCmd);
  actions.appendChild(btnDm);
  actions.appendChild(btnOpen);

  li.appendChild(badge);
  li.appendChild(urlSpan);
  li.appendChild(actions);
  return li;
}

function applyFilter() {
  const search = document.getElementById("search").value.toLowerCase();
  const type = document.getElementById("filter-type").value;

  const filtered = allUrls.filter(e => {
    const matchType = type === "all" || e.label === type;
    const matchSearch = !search || e.url.toLowerCase().includes(search);
    return matchType && matchSearch;
  });

  const list = document.getElementById("url-list");
  const empty = document.getElementById("empty-state");
  const copyAll = document.getElementById("btn-copy-all");
  const copyCmds = document.getElementById("btn-copy-cmds");
  const exportSel = document.getElementById("export-format");
  const count = document.getElementById("count");

  list.innerHTML = "";

  const has = filtered.length > 0;
  copyAll.disabled = !has;
  copyCmds.disabled = !has;
  exportSel.disabled = !has;

  if (!has) {
    empty.style.display = "block";
    count.textContent = allUrls.length === 0
      ? "0 found"
      : `0 of ${allUrls.length} match`;
  } else {
    empty.style.display = "none";
    filtered.forEach(e => list.appendChild(buildItem(e)));
    count.textContent = `${filtered.length} found`;
  }

  copyAll.onclick = () => copyText(filtered.map(e => e.url).join("\n"), copyAll);
  copyCmds.onclick = () => copyText(filtered.map(e => buildCommand(e, currentTool())).join("\n"), copyCmds);
  exportSel.onchange = () => {
    const fmt = exportSel.value;
    if (fmt) { exportList(filtered, fmt); exportSel.value = ""; }
  };
}

async function init() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;

  // Restore the last-used download tool.
  try {
    const saved = await browser.storage.local.get("tool");
    const sel = document.getElementById("tool-select");
    if (saved.tool && sel) sel.value = saved.tool;
  } catch (e) { /* ignore */ }

  document.getElementById("tool-select").addEventListener("change", (e) => {
    try { browser.storage.local.set({ tool: e.target.value }); } catch (err) { /* ignore */ }
  });

  const response = await browser.runtime.sendMessage({
    type: "GET_MEDIA",
    tabId: tab.id
  });

  allUrls = sortMedia(response?.urls || []);

  applyFilter();

  document.getElementById("search").addEventListener("input", applyFilter);
  document.getElementById("filter-type").addEventListener("change", applyFilter);

  document.getElementById("btn-clear").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "CLEAR_MEDIA", tabId: tab.id });
    allUrls = [];
    applyFilter();
  });
}

init();
