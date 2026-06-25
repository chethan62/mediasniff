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

  // AB Download Manager local REST API (direct files only; no HLS assembly).
  const ABDM_ADD_URL = "http://localhost:15151/add";
  // MediaSniff Grabber helper (helper/grab.py) — runs yt-dlp/ffmpeg for HLS.
  const GRABBER_URL = "http://localhost:15152/grab";
  // Job tracking (poll for progress after a grab).
  const GRABBER_JOBS_URL = "http://localhost:15152/jobs";
  const GRABBER_STATUS_URL = "http://localhost:15152/status/";

  const MEDIA_EXTS = [
    ".m3u8", ".mpd", ".mp4", ".mp3", ".webm",
    ".mkv", ".ogg", ".opus", ".flac", ".aac",
    ".ts", ".m4a", ".m4v", ".avi", ".mov",
    ".srt", ".vtt", ".ass", ".ssa", ".wav"
  ];

  const MEDIA_TYPES = [
    "video/", "audio/",
    "application/x-mpegurl",
    "application/vnd.apple.mpegurl",
    "application/dash+xml",
    "application/octet-stream",
    "text/vtt",
    "application/x-subrip",
    "text/plain"
  ];

  const SKIP_PATTERNS = [
    /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|css|js)(\?|$)/i,
    /\/ads?\//i,
    /doubleclick/i,
    /googlesyndication/i,
    /analytics/i,
    /tracking/i
  ];

  // Individual stream fragments — you grab the manifest, never these.
  const SEGMENT_RE = /\.(ts|m4s)(\?|#|$)|\/init(-\d+)?\.(mp4|m4s)(\?|#|$)/i;
  // Ad / cookie-sync / error endpoints that masquerade as media (e.g. Dailymotion dmxleo).
  const JUNK_RE = /[?&]error=|cookie[_-]?sync|cookiesync|dspcookiematching/i;

  // Label strictly from the final path extension (not a loose substring scan),
  // so query strings like `stream.m3u8?x=ad.mp4` are not mislabelled.
  const LABEL_BY_EXT = {
    m3u8: "HLS",
    mpd: "DASH",
    mp4: "MP4", m4v: "MP4",
    webm: "WEBM",
    mkv: "MKV",
    avi: "AVI",
    mov: "MOV",
    mp3: "AUDIO", m4a: "AUDIO", aac: "AUDIO",
    flac: "AUDIO", opus: "AUDIO", ogg: "AUDIO",
    wav: "WAV",
    ts: "TS segment",
    srt: "SRT", vtt: "VTT", ass: "ASS", ssa: "ASS"
  };

  const PRIORITY = { HLS: 0, DASH: 1, MP4: 2, WEBM: 3, MKV: 4, AVI: 5, MOV: 6, AUDIO: 7, WAV: 8, "TS segment": 9, SRT: 10, VTT: 11, ASS: 12, MEDIA: 13 };

  // Final path extension — strips BOTH query (?) and fragment (#), so
  // `manifest.m3u8#cell=cf3` is correctly seen as HLS.
  function realExt(url) {
    const m = String(url).toLowerCase().split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/);
    return m ? m[1] : "";
  }

  function isMediaUrl(url, contentType) {
    if (SKIP_PATTERNS.some(p => p.test(url))) return false;
    if (SEGMENT_RE.test(url)) return false;   // individual fragments — grab the manifest, not these
    if (JUNK_RE.test(url)) return false;        // ad / cookie-sync / error endpoints
    const urlLower = String(url).toLowerCase().split(/[?#]/)[0];
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

  // Streams that need an external assembler (yt-dlp/ffmpeg via the grabber).
  function isStream(entry) {
    return entry.label === "HLS" || entry.label === "DASH";
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

  // Headers object for AB Download Manager (only what we actually captured).
  function abdmHeaders(entry) {
    const h = {};
    if (entry.referer) h["Referer"] = entry.referer;
    if (entry.userAgent) h["User-Agent"] = entry.userAgent;
    return h;
  }

  // Body for POST http://localhost:15151/add — an array of download sources.
  function abdmPayload(entry) {
    return [{
      link: entry.url,
      headers: abdmHeaders(entry),
      downloadPage: entry.referer || ""
    }];
  }

  // Body for POST http://localhost:15152/grab — the grabber resolves the rest.
  // (format / subs keys are added by the popup UI, not by this pure helper.)
  function grabberPayload(entry) {
    return {
      url: entry.url,
      referer: entry.referer || "",
      userAgent: entry.userAgent || ""
    };
  }

  // Parse an HLS master manifest to extract variant streams with quality info.
  // Returns an array of { url, bandwidth, avgBandwidth, resolution, codecs, label }
  // or an empty array if this is a media playlist (no EXT-X-STREAM-INF lines).
  function parseMasterM3U8(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    let pending = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#EXT-X-ENDLIST")) continue;

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        pending = { bandwidth: 0, avgBandwidth: 0, resolution: "", codecs: "" };
        const attrs = line.slice(18);
        const bw = attrs.match(/BANDWIDTH=(\d+)/i);
        if (bw) pending.bandwidth = parseInt(bw[1], 10);
        const abw = attrs.match(/AVERAGE-BANDWIDTH=(\d+)/i);
        if (abw) pending.avgBandwidth = parseInt(abw[1], 10);
        const res = attrs.match(/RESOLUTION=(\d+x\d+)/i);
        if (res) pending.resolution = res[1];
        const cs = attrs.match(/CODECS="([^"]+)"/i);
        if (cs) pending.codecs = cs[1];
      } else if (pending && !line.startsWith("#")) {
        // Variant URL — resolve relative to base
        let url = line;
        try { url = new URL(line, baseUrl).href; } catch (e) { /* keep raw */ }
        const label = variantLabel(pending);
        variants.push({
          url, label,
          bandwidth: pending.bandwidth,
          avgBandwidth: pending.avgBandwidth,
          resolution: pending.resolution,
          codecs: pending.codecs,
          isAudio: isAudioVariant(pending)
        });
        pending = null;
      }
    }
    return variants;
  }

  // Human-readable label for a variant (e.g. "1080p · 4.2 Mbps · h264").
  function variantLabel(v) {
    const parts = [];
    const hasVideo = hasVideoCodec(v.codecs);
    const hasAudio = hasAudioCodec(v.codecs);

    if (v.resolution && hasVideo) {
      const h = parseInt(v.resolution.split("x")[1], 10);
      if (h >= 2160) parts.push("4K");
      else if (h >= 1440) parts.push("1440p");
      else if (h >= 1080) parts.push("1080p");
      else if (h >= 720) parts.push("720p");
      else if (h >= 480) parts.push("480p");
      else parts.push(v.resolution);
    }
    const bw = v.avgBandwidth || v.bandwidth;
    if (bw > 0) parts.push(formatBitrate(bw));
    if (v.codecs) {
      const c = v.codecs.toLowerCase();
      if (hasVideo && hasAudio) {
        // Combined — show video codec only (audio is implied)
        if (c.includes("avc") || c.includes("h264")) parts.push("h264");
        else if (c.includes("hvc") || c.includes("hevc")) parts.push("h265");
        else if (c.includes("vp9")) parts.push("vp9");
        else if (c.includes("av1")) parts.push("av1");
      } else if (hasAudio) {
        if (c.includes("mp4a") || c.includes("aac")) parts.push("aac");
        else if (c.includes("opus")) parts.push("opus");
        else if (c.includes("ac3") || c.includes("ec3")) parts.push("ac3");
      } else if (hasVideo) {
        if (c.includes("avc") || c.includes("h264")) parts.push("h264");
        else if (c.includes("hvc") || c.includes("hevc")) parts.push("h265");
        else if (c.includes("vp9")) parts.push("vp9");
        else if (c.includes("av1")) parts.push("av1");
      }
    }
    if (hasAudio && !hasVideo) parts.push("audio");
    return parts.join(" · ") || "variant";
  }

  function hasVideoCodec(cs) {
    return cs && /(avc|hvc|hevc|vp9|av1|h264|h265)/i.test(cs);
  }

  function hasAudioCodec(cs) {
    return cs && /(mp4a|aac|opus|vorbis|ac3|ec3)/i.test(cs);
  }

  function isAudioVariant(v) {
    return hasAudioCodec(v.codecs) && !hasVideoCodec(v.codecs);
  }

  function formatBitrate(bps) {
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " Mbps";
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " Kbps";
    return bps + " bps";
  }

  // Detect if an M3U8 text is a master playlist (has EXT-X-STREAM-INF)
  // vs a media playlist (has EXTINF segments).
  function isMasterM3U8(text) {
    return /^#EXT-X-STREAM-INF:/m.test(text) && !/^#EXTINF:/m.test(text);
  }

  function formatFileSize(bytes) {
    if (bytes == null || bytes < 0) return "";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + " KB";
    return bytes + " B";
  }

  return {
    MAX_PER_TAB, ABDM_ADD_URL, GRABBER_URL, GRABBER_JOBS_URL, GRABBER_STATUS_URL,
    MEDIA_EXTS, MEDIA_TYPES, SKIP_PATTERNS, LABEL_BY_EXT, PRIORITY,
    realExt, isMediaUrl, labelUrl, isStream, outExt, shq, buildCommand, shortUrl,
    sortMedia, exportContent, abdmHeaders, abdmPayload, grabberPayload,
    parseMasterM3U8, isMasterM3U8, formatBitrate, formatFileSize
  };
});
