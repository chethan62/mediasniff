// Cross-browser namespace shim (Chromium exposes only `chrome`).
const browser = globalThis.browser ?? globalThis.chrome;

// shortUrl, buildCommand, outExt, shq, sortMedia, exportContent, abdmPayload,
// grabberPayload come from lib/media.js (loaded first in popup.html).

let allUrls = [];
let pageTitle = "";

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

// --- Generic background-message send with button feedback (DM). ---
function flashResult(btn, orig, ok, okText, failText) {
  btn.textContent = ok ? okText : failText;
  btn.classList.add(ok ? "copied" : "fail");
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove("copied", "fail");
    btn.disabled = false;
  }, 1700);
}

function sendMsg(type, payload, btn, okText, failText) {
  const orig = btn.textContent;
  btn.textContent = "…";
  btn.disabled = true;
  browser.runtime.sendMessage({ type, payload })
    .then(res => flashResult(btn, orig, !!(res && res.ok), okText, failText))
    .catch(() => flashResult(btn, orig, false, okText, failText));
}

// --- Grab: send to the local helper, then poll its job for live progress. ---
async function doGrab(entry, btn) {
  const orig = "Grab";
  btn.textContent = "…";
  btn.disabled = true;
  btn.classList.remove("copied", "fail");
  try {
    const payload = grabberPayload(entry);
    const q = document.getElementById("quality-select");
    if (q && q.value) payload.format = q.value;
    const subs = document.getElementById("subs-check");
    if (subs && subs.checked) payload.subs = true;

    if (pageTitle) payload.name = pageTitle;

    const res = await browser.runtime.sendMessage({ type: "SEND_TO_GRABBER", payload });
    if (res && res.ok && res.id != null) {
      btn.textContent = "0%";
      pollJob(btn, res.id, orig);
    } else {
      flashResult(btn, orig, false, "Started", "Helper?");
    }
  } catch (e) {
    flashResult(btn, orig, false, "Started", "Helper?");
  }
}

function pollJob(btn, id, orig) {
  const finish = (txt, cls) => {
    btn.textContent = txt;
    if (cls) btn.classList.add(cls);
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("copied", "fail");
      btn.disabled = false;
    }, 2500);
  };
  const timer = setInterval(async () => {
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "GET_JOB_STATUS", id });
    } catch (e) {
      clearInterval(timer); finish("Helper?", "fail"); return;
    }
    if (!res || !res.ok) return;                     // transient — keep polling
    if (res.status === "done") { clearInterval(timer); finish("Done✓", "copied"); }
    else if (res.status === "failed") { clearInterval(timer); finish("Failed✗", "fail"); }
    else { btn.textContent = Math.floor(res.pct || 0) + "%"; }
  }, 1500);
}

function fileIcon(file) {
  const ext = (file || "").split(".").pop().toLowerCase();
  if (/^(mp4|mkv|webm|mov|avi|m4v)$/i.test(ext)) return "🎬";
  if (/^(m4a|mp3|aac|flac|opus|ogg|wav)$/i.test(ext)) return "🎵";
  if (/^(srt|vtt|ass|ssa)$/i.test(ext)) return "💬";
  if (/^(m4s|ts)$/i.test(ext)) return "📦";
  return "📄";
}

// --- Downloads panel: poll the helper's job list and render progress. ---
async function pollDownloads() {
  const panel = document.getElementById("downloads-panel");
  if (!panel) return;
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "GET_JOBS" });
  } catch (e) {
    panel.style.display = "none";
    return;
  }
  const jobs = (res && res.ok && Array.isArray(res.jobs)) ? res.jobs : [];
  if (!jobs.length) {
    panel.style.display = "none";
    panel.replaceChildren();
    return;
  }
  panel.style.display = "block";
  const frag = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "dl-title";
  title.textContent = "Downloads";
  const clearBtn = document.createElement("button");
  clearBtn.className = "dl-clear";
  clearBtn.textContent = "Clear";
  clearBtn.onclick = async () => {
    try { await browser.runtime.sendMessage({ type: "CLEAR_JOBS" }); } catch (e) { /* offline */ }
    pollDownloads();
  };
  title.appendChild(clearBtn);
  frag.appendChild(title);
  jobs.slice(0, 8).forEach(j => {
    const row = document.createElement("div");
    row.className = "dl-job " + (j.status === "done" ? "dl-done" : j.status === "failed" ? "dl-fail" : "dl-run");
    const pct = document.createElement("span");
    pct.className = "dl-pct";
    pct.textContent = j.status === "done" ? "✓" : j.status === "failed" ? "✗" : (Math.floor(j.pct || 0) + "%");
    const name = document.createElement("span");
    name.className = "dl-name";
    name.textContent = fileIcon(j.file) + " " + (j.file ? String(j.file).split("/").pop() : shortUrl(j.url || ""));
    name.title = j.url || "";
    row.appendChild(pct);
    row.appendChild(name);
    frag.appendChild(row);
  });
  panel.replaceChildren(frag);
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
  badge.title = entry.label;
  if (entry.label === "HLS") {
    const p = entry.url.split(/[?#]/)[0].toLowerCase();
    if (/\/(aac|audio|ac3)($|_|\/)/.test(p)) {
      badge.title += " — audio-only variant"; badge.classList.add("badge-var");
    } else if (/\/(h264|h265|hevc|vp9|hd|hq)($|_|\/)/.test(p)) {
      badge.title += " — video-only variant"; badge.classList.add("badge-var");
    } else {
      badge.title += " — master"; badge.classList.add("badge-master");
    }
  }
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
  btnDm.title = "Send to AB Download Manager (direct files; not HLS)";
  btnDm.onclick = () => sendMsg("SEND_TO_ABDM", abdmPayload(entry), btnDm, "Sent!", "ABDM?");

  const btnGrab = document.createElement("button");
  btnGrab.className = "btn-grab";
  btnGrab.textContent = "Grab";
  btnGrab.title = "Download via the local grabber (yt-dlp/ffmpeg) with live progress. Start it with: npm run helper";
  btnGrab.onclick = () => doGrab(entry, btnGrab);

  const btnOpen = document.createElement("button");
  btnOpen.className = "btn-open";
  btnOpen.textContent = "Open";
  btnOpen.onclick = () => browser.tabs.create({ url: entry.url });

  actions.appendChild(btnCopy);
  actions.appendChild(btnCmd);
  actions.appendChild(btnDm);
  actions.appendChild(btnGrab);
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

function bindPref(id, prop, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", (e) => {
    try { browser.storage.local.set({ [key]: e.target[prop] }); } catch (err) { /* ignore */ }
  });
}

async function init() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;
  pageTitle = tab.title || "";

  // Restore saved prefs (tool / quality / subs).
  try {
    const saved = await browser.storage.local.get(["tool", "quality", "subs"]);
    const tool = document.getElementById("tool-select");
    if (tool && saved.tool) tool.value = saved.tool;
    const q = document.getElementById("quality-select");
    if (q && saved.quality != null) q.value = saved.quality;
    const s = document.getElementById("subs-check");
    if (s) s.checked = !!saved.subs;
  } catch (e) { /* ignore */ }

  bindPref("tool-select", "value", "tool");
  bindPref("quality-select", "value", "quality");
  bindPref("subs-check", "checked", "subs");

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

  // Live downloads panel (polls the helper while the popup is open).
  pollDownloads();
  setInterval(pollDownloads, 2500);
}

init();
