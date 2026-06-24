// Cross-browser namespace shim (Chromium exposes only `chrome`).
const browser = globalThis.browser ?? globalThis.chrome;

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

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 60
      ? "…" + u.pathname.slice(-55)
      : u.pathname;
    return u.hostname + path;
  } catch {
    return url.length > 80 ? url.slice(0, 77) + "…" : url;
  }
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("copied");
    }, 1400);
  });
}

function realExt(url) {
  const m = url.toLowerCase().split("?")[0].match(/\.([a-z0-9]{2,4})$/);
  return m ? m[1] : "";
}

function outExt(entry) {
  if (entry.label === "HLS" || entry.label === "DASH") return "mp4";
  const ext = realExt(entry.url);
  if (ext) return ext;
  if (entry.label === "AUDIO") return "m4a";
  if (entry.label === "WEBM") return "webm";
  return "mp4";
}

function currentTool() {
  const el = document.getElementById("tool-select");
  return el ? el.value : "yt-dlp";
}

function buildCommand(entry) {
  const url = entry.url;
  if (currentTool() === "ffmpeg") {
    return `ffmpeg -i "${url}" -c copy "output.${outExt(entry)}"`;
  }
  if (entry.label === "AUDIO") {
    return `yt-dlp -x --audio-format mp3 "${url}"`;
  }
  return `yt-dlp "${url}"`;
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
  if (fmt === "json") {
    const data = list.map(e => ({ url: e.url, type: e.label, contentType: e.contentType }));
    downloadBlob(`mediasniff-${stamp}.json`, JSON.stringify(data, null, 2), "application/json");
  } else if (fmt === "m3u") {
    const body = list.map(e => `#EXTINF:-1,${e.label} - ${shortUrl(e.url)}\n${e.url}`).join("\n");
    downloadBlob(`mediasniff-${stamp}.m3u`, `#EXTM3U\n${body}\n`, "audio/x-mpegurl");
  } else {
    downloadBlob(`mediasniff-${stamp}.txt`, list.map(e => e.url).join("\n") + "\n", "text/plain");
  }
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
  btnCmd.title = "Copy download command";
  btnCmd.onclick = () => copyText(buildCommand(entry), btnCmd);

  const btnOpen = document.createElement("button");
  btnOpen.className = "btn-open";
  btnOpen.textContent = "Open";
  btnOpen.onclick = () => browser.tabs.create({ url: entry.url });

  actions.appendChild(btnCopy);
  actions.appendChild(btnCmd);
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
  copyCmds.onclick = () => copyText(filtered.map(e => buildCommand(e)).join("\n"), copyCmds);
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

  allUrls = (response?.urls || []).sort((a, b) => {
    const priority = { HLS: 0, DASH: 1, MP4: 2, WEBM: 3, AUDIO: 4, "TS segment": 5, MEDIA: 6 };
    return (priority[a.label] ?? 9) - (priority[b.label] ?? 9);
  });

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
