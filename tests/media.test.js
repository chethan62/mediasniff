/*
 * MediaSniff feature proof — zero-dependency Node test suite.
 * Run: node tests/media.test.js   (exit 0 = all pass)
 *
 * Exercises the REAL shipped logic in ../lib/media.js (the same file the
 * extension loads), so a green run proves the features themselves.
 */
const assert = require("assert");
const M = require("../lib/media.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n         " + e.message); }
}
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const ok = (c, m) => assert.ok(c, m);

// ---- isMediaUrl: positives ----
test("isMediaUrl detects .m3u8 / .mpd / .mp4 / .mp3", () => {
  ok(M.isMediaUrl("https://h/s.m3u8", ""));
  ok(M.isMediaUrl("https://h/s.mpd", ""));
  ok(M.isMediaUrl("https://h/v.mp4?t=1", ""));
  ok(M.isMediaUrl("https://h/a.mp3", ""));
});
test("isMediaUrl detects by content-type with no extension", () => {
  ok(M.isMediaUrl("https://h/play", "video/mp4"));
  ok(M.isMediaUrl("https://h/manifest", "application/dash+xml"));
  ok(M.isMediaUrl("https://h/list", "application/vnd.apple.mpegurl"));
});

// ---- isMediaUrl: negatives ----
test("isMediaUrl rejects images / scripts / styles", () => {
  ok(!M.isMediaUrl("https://h/a.png", "image/png"));
  ok(!M.isMediaUrl("https://h/app.js", "application/javascript"));
  ok(!M.isMediaUrl("https://h/x.css", "text/css"));
});
test("isMediaUrl rejects ads / trackers even if media-ish", () => {
  ok(!M.isMediaUrl("https://doubleclick.net/v.mp4", "video/mp4"));
  ok(!M.isMediaUrl("https://h/ads/clip.mp4", "video/mp4"));
  ok(!M.isMediaUrl("https://h/analytics/beacon.mp4", "video/mp4"));
});
test("isMediaUrl rejects plain page with no ext / no media ct", () => {
  ok(!M.isMediaUrl("https://h/page", "text/html"));
});

// ---- labelUrl: precision ----
test("labelUrl maps each type from the final extension", () => {
  eq(M.labelUrl("https://h/s.m3u8"), "HLS");
  eq(M.labelUrl("https://h/s.mpd"), "DASH");
  eq(M.labelUrl("https://h/v.mp4"), "MP4");
  eq(M.labelUrl("https://h/c.webm"), "WEBM");
  eq(M.labelUrl("https://h/a.aac"), "AUDIO");
  eq(M.labelUrl("https://h/seg.ts"), "TS segment");
});
test("labelUrl is not fooled by query strings (m3u8 with ?x=ad.mp4 stays HLS)", () => {
  eq(M.labelUrl("https://h/stream.m3u8?ad=promo.mp4"), "HLS");
});
test("labelUrl falls back to MEDIA for unknown/extensionless", () => {
  eq(M.labelUrl("https://h/movie.mkv"), "MEDIA");
  eq(M.labelUrl("https://h/play"), "MEDIA");
});

// ---- realExt / outExt ----
test("realExt strips query and returns final extension", () => {
  eq(M.realExt("https://h/v.mp4?a=1"), "mp4");
  eq(M.realExt("https://h/play"), "");
});
test("outExt remuxes streams to mp4, keeps real ext otherwise", () => {
  eq(M.outExt({ label: "HLS", url: "https://h/s.m3u8" }), "mp4");
  eq(M.outExt({ label: "DASH", url: "https://h/s.mpd" }), "mp4");
  eq(M.outExt({ label: "AUDIO", url: "https://h/a.aac" }), "aac");
  eq(M.outExt({ label: "AUDIO", url: "https://h/stream" }), "m4a");
  eq(M.outExt({ label: "WEBM", url: "https://h/c" }), "webm");
});

// ---- shq escaping ----
test("shq wraps in single quotes and escapes embedded apostrophes", () => {
  eq(M.shq("plain"), "'plain'");
  eq(M.shq("a'b"), "'a'\\''b'");
});

// ---- buildCommand: exact strings ----
test("buildCommand yt-dlp plain direct file", () => {
  eq(M.buildCommand({ label: "MP4", url: "https://h/clip.mp4" }, "yt-dlp"),
    "yt-dlp 'https://h/clip.mp4'");
});
test("buildCommand yt-dlp HLS with Referer + User-Agent", () => {
  eq(M.buildCommand({ label: "HLS", url: "https://cdn/s.m3u8", referer: "https://site/watch", userAgent: "UA/1.0" }, "yt-dlp"),
    "yt-dlp --referer 'https://site/watch' --user-agent 'UA/1.0' 'https://cdn/s.m3u8'");
});
test("buildCommand yt-dlp audio adds -x --audio-format mp3", () => {
  eq(M.buildCommand({ label: "AUDIO", url: "https://h/a.aac" }, "yt-dlp"),
    "yt-dlp -x --audio-format mp3 'https://h/a.aac'");
});
test("buildCommand ffmpeg puts header opts before -i and remuxes HLS to mp4", () => {
  eq(M.buildCommand({ label: "HLS", url: "https://cdn/s.m3u8", referer: "https://site/watch", userAgent: "UA/1.0" }, "ffmpeg"),
    "ffmpeg -user_agent 'UA/1.0' -headers 'Referer: https://site/watch' -i 'https://cdn/s.m3u8' -c copy 'output.mp4'");
});
test("buildCommand is shell-safe with apostrophes in the URL", () => {
  eq(M.buildCommand({ label: "MP4", url: "https://h/it's.mp4" }, "yt-dlp"),
    "yt-dlp 'https://h/it'\\''s.mp4'");
});

// ---- sortMedia priority ----
test("sortMedia orders HLS<DASH<MP4<WEBM<AUDIO<TS<MEDIA", () => {
  const input = [
    { label: "MEDIA" }, { label: "TS segment" }, { label: "AUDIO" },
    { label: "WEBM" }, { label: "MP4" }, { label: "DASH" }, { label: "HLS" }
  ];
  eq(M.sortMedia(input).map(e => e.label),
    ["HLS", "DASH", "MP4", "WEBM", "AUDIO", "TS segment", "MEDIA"]);
});

// ---- exportContent: txt / json / m3u ----
const sample = [
  { url: "https://h/s.m3u8", label: "HLS", contentType: "application/x-mpegurl", referer: "https://site/", userAgent: "UA/1.0" },
  { url: "https://h/a.aac", label: "AUDIO", contentType: "audio/aac" }
];
test("exportContent txt = newline-joined URLs", () => {
  eq(M.exportContent(sample, "txt"), "https://h/s.m3u8\nhttps://h/a.aac\n");
});
test("exportContent json includes type + captured referer/userAgent", () => {
  const parsed = JSON.parse(M.exportContent(sample, "json"));
  eq(parsed.length, 2);
  eq(parsed[0].type, "HLS");
  eq(parsed[0].referer, "https://site/");
  eq(parsed[0].userAgent, "UA/1.0");
  eq(parsed[1].referer, ""); // missing -> empty, not undefined
});
test("exportContent m3u is a valid playlist", () => {
  const m = M.exportContent(sample, "m3u");
  ok(m.startsWith("#EXTM3U\n"));
  ok(m.includes("#EXTINF:-1,HLS - "));
  ok(m.includes("https://h/s.m3u8"));
});

// ---- guard rails ----
test("MAX_PER_TAB is a sane positive cap", () => {
  ok(Number.isInteger(M.MAX_PER_TAB) && M.MAX_PER_TAB > 0);
});

// ---- ABDM integration payload ----
test("ABDM_ADD_URL targets the local AB Download Manager REST endpoint", () => {
  eq(M.ABDM_ADD_URL, "http://localhost:15151/add");
});
test("abdmPayload wraps link + captured headers + downloadPage", () => {
  const p = M.abdmPayload({ url: "https://cdn/s.m3u8", referer: "https://site/watch", userAgent: "UA/1.0" });
  ok(Array.isArray(p));
  eq(p[0].link, "https://cdn/s.m3u8");
  eq(p[0].headers.Referer, "https://site/watch");
  eq(p[0].headers["User-Agent"], "UA/1.0");
  eq(p[0].downloadPage, "https://site/watch");
});
test("abdmPayload uses an empty header object + downloadPage when none captured", () => {
  const p = M.abdmPayload({ url: "https://h/v.mp4" });
  eq(p[0].headers, {});
  eq(p[0].downloadPage, "");
});

// ---- Grabber (local helper) payload ----
test("GRABBER_URL targets the local grabber helper", () => {
  eq(M.GRABBER_URL, "http://localhost:15152/grab");
});
test("grabber job-tracking endpoints are the expected localhost URLs", () => {
  eq(M.GRABBER_JOBS_URL, "http://localhost:15152/jobs");
  eq(M.GRABBER_STATUS_URL, "http://localhost:15152/status/");
});
test("grabberPayload sends url + captured headers", () => {
  const p = M.grabberPayload({ url: "https://cdn/s.m3u8", referer: "https://site/", userAgent: "UA/1.0" });
  eq(p.url, "https://cdn/s.m3u8");
  eq(p.referer, "https://site/");
  eq(p.userAgent, "UA/1.0");
});
test("isStream is true only for HLS/DASH", () => {
  ok(M.isStream({ label: "HLS" }));
  ok(M.isStream({ label: "DASH" }));
  ok(!M.isStream({ label: "MP4" }));
  ok(!M.isStream({ label: "AUDIO" }));
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
