/*
 * MediaSniff shared logic — pure, browser-independent helpers.
 *
 * Loaded both by the extension (attaches its API to the global object so
 * background.js / popup.js can call the functions as bare globals) AND by the
 * Node test suite (module.exports). No `browser.*` or DOM access lives here,
 * which is exactly what makes every feature unit-testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Cap stored media per tab so a long HLS session (hundreds of .ts segments)
  // can't balloon memory / storage.session unbounded.
  const MAX_PER_TAB = 500;

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

  // Label strictly from the final path extension (not a loose substring scan),
  // so query strings like `stream.m3u8?x=ad.mp4` are not mislabelled.
  const LABEL_BY_EXT = {
    m3u8: "HLS",
    mpd: "DASH",
    mp4: "MP4", m4v: "MP4",
    webm: "WEBM",
    mp3: "AUDIO", m4a: "AUDIO", aac: "AUDIO",
    flac: "AUDIO", opus: "AUDIO", ogg: "AUDIO",
    ts: "TS segment"
  };

  const PRIORITY = { HLS: 0, DASH: 1, MP4: 2, WEBM: 3, AUDIO: 4, "TS segment": 5, MEDIA: 6 };

  function realExt(url) {
    const m = String(url).toLowerCase().split("?")[0].match(/\.([a-z0-9]{2,4})$/);
    return m ? m[1] : "";
  }

  function isMediaUrl(url, contentType) {
    if (SKIP_PATTERNS.some(p => p.test(url))) return false;
    const urlLower = String(url).toLowerCase().split("?")[0];
    if (MEDIA_EXTS.some(ext => urlLower.endsWith(ext))) return true;
    if (contentType) {
      const ct = String(contentType).toLowerCase();
      if (MEDIA_TYPES.some(t => ct.startsWith(t))) return true;
    }
    return false;
  }

  function labelUrl(url) {
    return LABEL_BY_EXT[realExt(url)] || "MEDIA";
  }

  function outExt(entry) {
    if (entry.label === "HLS" || entry.label === "DASH") return "mp4";
    const ext = realExt(entry.url);
    if (ext) return ext;
    if (entry.label === "AUDIO") return "m4a";
    if (entry.label === "WEBM") return "webm";
    return "mp4";
  }

  // POSIX single-quote escaping: wrap in '...' and turn embedded ' into '\''.
  function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  // Build an external download command. Captured Referer / User-Agent are
  // injected so the command works on streams that 403 without them.
  function buildCommand(entry, tool) {
    const ref = entry.referer || "";
    const ua = entry.userAgent || "";
    if (tool === "ffmpeg") {
      const parts = ["ffmpeg"];
      if (ua) parts.push("-user_agent " + shq(ua));
      if (ref) parts.push("-headers " + shq("Referer: " + ref));
      parts.push("-i " + shq(entry.url), "-c copy", shq("output." + outExt(entry)));
      return parts.join(" ");
    }
    const parts = ["yt-dlp"];
    if (ref) parts.push("--referer " + shq(ref));
    if (ua) parts.push("--user-agent " + shq(ua));
    if (entry.label === "AUDIO") parts.push("-x --audio-format mp3");
    parts.push(shq(entry.url));
    return parts.join(" ");
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 60 ? "…" + u.pathname.slice(-55) : u.pathname;
      return u.hostname + path;
    } catch (e) {
      return url.length > 80 ? url.slice(0, 77) + "…" : url;
    }
  }

  function sortMedia(list) {
    return list.slice().sort((a, b) => (PRIORITY[a.label] ?? 9) - (PRIORITY[b.label] ?? 9));
  }

  function exportContent(list, fmt) {
    if (fmt === "json") {
      const data = list.map(e => ({
        url: e.url,
        type: e.label,
        contentType: e.contentType,
        referer: e.referer || "",
        userAgent: e.userAgent || ""
      }));
      return JSON.stringify(data, null, 2) + "\n";
    }
    if (fmt === "m3u") {
      const body = list.map(e => `#EXTINF:-1,${e.label} - ${shortUrl(e.url)}\n${e.url}`).join("\n");
      return `#EXTM3U\n${body}\n`;
    }
    return list.map(e => e.url).join("\n") + "\n";
  }

  return {
    MAX_PER_TAB, MEDIA_EXTS, MEDIA_TYPES, SKIP_PATTERNS, LABEL_BY_EXT, PRIORITY,
    realExt, isMediaUrl, labelUrl, outExt, shq, buildCommand, shortUrl, sortMedia, exportContent
  };
});
