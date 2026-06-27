#!/usr/bin/env python3
"""
MediaSniff Grabber — a tiny local helper that downloads HLS/DASH (or direct)
media URLs sniffed by the MediaSniff browser extension, with job tracking
so the extension can show real progress instead of fire-and-forget.

HLS/DASH (.m3u8/.mpd) are handled by N_m3u8DL-RE when present (parses the
playlist, downloads every segment concurrently, decrypts AES-128, and merges
separate video+audio variants to mp4 — robust where yt-dlp's generic extractor
fails, e.g. Dailymotion partner streams). Direct files fall back to yt-dlp,
then ffmpeg.

Endpoints:
    POST /grab   {url,referer,userAgent,name?,format?,subs?,audioUrl?}
                 → 202 {"ok":true,"started":true,"id":<int>}
    GET  /jobs                   → {"ok":true,"jobs":[{id,url,status,pct,file}]}
    GET  /status/<id>            → {"ok":true,"id":…,"status":"done"|"failed"|"downloading","pct":…,"file":"…"}
    GET  /health                 → {"ok":true,"n_m3u8dl":bool,"ytdlp":bool,"ffmpeg":bool,"out":"…"}

Run:
    python3 helper/grab.py        # 127.0.0.1:15152
Env:
    MEDIASNIFF_PORT   port         (default 15152)
    MEDIASNIFF_OUT    output dir   (default ~/Downloads)
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("MEDIASNIFF_PORT", "15152"))
OUT = os.path.expanduser(os.environ.get("MEDIASNIFF_OUT", "~/Downloads"))
UA_DEFAULT = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"

def _which(name):
    """Find an executable on PATH, then in common per-user bin dirs (cross-platform:
    Linux ~/.local/bin, Windows %LOCALAPPDATA%\\Programs\\mediasniff, or $MEDIASNIFF_BIN)."""
    p = shutil.which(name)
    if p:
        return p
    exts = [""] + (os.environ.get("PATHEXT", "").split(os.pathsep) if os.name == "nt" else [])
    dirs = [os.environ.get("MEDIASNIFF_BIN", ""),
            os.path.expanduser("~/.local/bin"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "mediasniff")]
    for d in dirs:
        if not d:
            continue
        for ext in exts:
            cand = os.path.join(d, name + ext)
            if os.path.isfile(cand):
                return cand
    return None


NM3U8 = _which("N_m3u8DL-RE")
VSD = _which("vsd")      # Rust-based HLS/DASH downloader (preferred — faster, smaller)
YTDLP = _which("yt-dlp")
FFMPEG = _which("ffmpeg")

jobs = {}          # id → {url, referer, userAgent, name, format, subs, audioUrl, status, pct, file, error}
_next_id = 1
SAFE_JOB_KEYS = {"url", "status", "pct", "file", "error", "format", "subs"}

PERCENT_RE = re.compile(r"([\d.]+)%")
DEST_RE = re.compile(r"Destination:\s*(.+)")

# Strip characters unsafe in filenames across platforms.
_FNAME_BAD_RE = re.compile(r'[\\/:<>|?*"]')


def _safe_name(text, max_len=200):
    """Return a filesystem-safe name from user-provided text (e.g. page title)."""
    s = _FNAME_BAD_RE.sub("_", (text or "").strip()).strip(". ")
    return s[:max_len] if s else "download"


def log(*a):
    print("[grabber]", *a, flush=True)


def _stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def _is_stream(url):
    path = url.split("?", 1)[0].split("#", 1)[0].lower()
    return path.endswith(".m3u8") or path.endswith(".mpd")


def run_download(job_id):
    job = jobs[job_id]
    url = job.get("url")
    referer = job.get("referer") or ""
    ua = job.get("userAgent") or UA_DEFAULT
    audio = job.get("audioUrl") or ""
    fmt = (job.get("format") or "").strip()
    subs = job.get("subs", False)
    os.makedirs(OUT, exist_ok=True)
    # Use the page-title name if the extension sent one, otherwise a unique stamp.
    user_name = (job.get("name") or "").strip()
    if user_name:
        safe_fn = _safe_name(user_name)
    else:
        safe_fn = "mediasniff_%s_%d" % (_stamp(), job_id)
    out_mp4 = os.path.join(OUT, safe_fn + ".mp4")
    job["status"] = "downloading"
    job["pct"] = 0
    try:
        if _is_stream(url) and VSD and not audio:
            # Rust vsd — fast, single-binary, percent-only progress for MediaSniff.
            cmd = [VSD, "save", url,
                   "--percent-only", "--color", "never",
                   "-t", "8",
                   "-o", out_mp4]
            for hname, hval in (("Referer", referer), ("User-Agent", ua)):
                if hval:
                    cmd += ["-H", "%s: %s" % (hname, hval)]
            job["file"] = safe_fn + ".mp4"
        elif _is_stream(url) and NM3U8 and not audio:
            # Dedicated HLS/DASH engine: parse playlist, download every segment
            # concurrently (segments go to --tmp-dir on tmpfs /tmp), then merge
            # to OUT. The --tmp-dir on RAM already protects the SSD from hundreds
            # of small segment writes; the final merge is one sequential write.
            cmd = [NM3U8, url,
                   "--tmp-dir", tempfile.gettempdir(),
                   "--save-dir", OUT, "--save-name", safe_fn,
                   "--thread-count", "8", "-mt",
                   "--enable-resume",
                   "--progress-format", "plain",
                   "--no-log", "--no-ansi-color", "--disable-update-check",
                   "-M", "format=mp4"]
            if FFMPEG:
                cmd += ["--ffmpeg-binary-path", FFMPEG]
            qv, qa = ("worst", "worst") if fmt == "worst" else ("best", "best")
            cmd += ["-sv", qv, "-sa", qa]
            if subs:
                cmd += ["-ss", "all"]
            for hname, hval in (("Referer", referer), ("User-Agent", ua)):
                if hval:
                    cmd += ["-H", "%s: %s" % (hname, hval)]
            job["file"] = safe_fn + ".mp4"
        elif audio and FFMPEG:
            # explicit video + audio variant mux (master expired / split renditions).
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", url,
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", audio,
                   "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", out_mp4]
            job["file"] = safe_fn + ".mp4"
        elif YTDLP:
            cmd = [YTDLP, "--newline", "--no-warnings", "-N", "8",
                   "--restrict-filenames", "--merge-output-format", "mp4",
                   "--user-agent", ua]
            if referer:
                cmd += ["--referer", referer]
            if fmt:
                cmd += ["-f", fmt]
            if subs:
                cmd += ["--write-subs", "--sub-langs", "all"]
            if user_name:
                # extension gave us a name — use it (no title-guessing)
                cmd += ["-o", os.path.join(OUT, safe_fn + ".%(ext)s"), url]
            else:
                cmd += ["-o", os.path.join(OUT, "%(title).150B_[%(id)s].%(ext)s"), url]
        elif FFMPEG:
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer,
                   "-i", url, "-c", "copy", out_mp4]
            job["file"] = safe_fn + ".mp4"
        else:
            job["status"] = "failed"
            job["error"] = "no downloader (N_m3u8DL-RE / yt-dlp / ffmpeg) found"
            return

        log("START", os.path.basename(cmd[0]), "->", url[:90])
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        tail = []
        for line in p.stdout or []:
            line = line.rstrip()
            if line:
                tail.append(line)
                if len(tail) > 8:
                    tail.pop(0)
            m = PERCENT_RE.search(line)
            if m:
                try:
                    job["pct"] = float(m.group(1))
                except ValueError:
                    pass
            m2 = DEST_RE.search(line)
            if m2:
                job["file"] = m2.group(1).strip()
        p.wait()
        if p.returncode == 0:
            job["status"] = "done"
            job["pct"] = 100
            if "file" not in job:
                job["file"] = url.rsplit("/", 1)[-1].split("?")[0] or "unknown"
        else:
            job["status"] = "failed"
            err = next((t for t in reversed(tail) if "ERROR" in t.upper()), tail[-1] if tail else "")
            job["error"] = ("exit %d: %s" % (p.returncode, err))[:300]
        log("DONE rc=%d" % p.returncode, url[:90])
    except Exception as e:  # noqa: BLE001
        job["status"] = "failed"
        job["error"] = str(e)[:300]
        log("EXC", repr(e))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path).path
        if p == "/health":
            return self._json(200, {
                "ok": True, "n_m3u8dl": bool(NM3U8), "vsd": bool(VSD), "ytdlp": bool(YTDLP),
                "ffmpeg": bool(FFMPEG), "out": OUT
            })
        if p == "/jobs":
            jlist = [{"id": i, **{k: v for k, v in j.items() if k in SAFE_JOB_KEYS}}
                     for i, j in jobs.items()]
            jlist.sort(key=lambda x: x["id"], reverse=True)
            return self._json(200, {"ok": True, "jobs": jlist[:20]})
        if p.startswith("/status/"):
            try:
                jid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                return self._json(400, {"ok": False, "error": "bad id"})
            j = jobs.get(jid)
            if not j:
                return self._json(404, {"ok": False, "error": "not found"})
            return self._json(200, {"ok": True, "id": jid,
                                     **{k: v for k, v in j.items() if k in ("status", "pct", "file", "error", "url")}})
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        p = urlparse(self.path).path
        if p.startswith("/retry/"):
            try:
                jid = int(p.rsplit("/", 1)[-1])
            except ValueError:
                return self._json(400, {"ok": False, "error": "bad id"})
            job = jobs.get(jid)
            if not job:
                return self._json(404, {"ok": False, "error": "not found"})
            if job["status"] not in ("failed", "done"):
                return self._json(409, {"ok": False, "error": "job is " + job["status"]})
            job["status"] = "queued"
            job["pct"] = 0
            job.pop("error", None)
            job.pop("file", None)
            threading.Thread(target=run_download, args=(jid,), daemon=True).start()
            return self._json(202, {"ok": True, "restarted": True, "id": jid})

        if p != "/grab":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"ok": False, "error": "bad json: %s" % e})
        if not data.get("url"):
            return self._json(400, {"ok": False, "error": "missing url"})
        if not (NM3U8 or YTDLP or FFMPEG):
            return self._json(500, {"ok": False, "error": "no downloader installed"})

        global _next_id
        jid = _next_id
        _next_id += 1
        jobs[jid] = {
            "url": data["url"],
            "referer": data.get("referer", ""),
            "userAgent": data.get("userAgent", "") or UA_DEFAULT,
            "name": data.get("name", ""),
            "format": data.get("format", ""),
            "subs": data.get("subs", False),
            "audioUrl": data.get("audioUrl", ""),
            "status": "queued",
            "pct": 0,
        }
        threading.Thread(target=run_download, args=(jid,), daemon=True).start()
        return self._json(202, {"ok": True, "started": True, "id": jid})

    def do_DELETE(self):
        p = urlparse(self.path).path
        if p == "/jobs":
            jobs.clear()
            return self._json(200, {"ok": True})
        return self._json(404, {"ok": False, "error": "not found"})

    def log_message(self, format, *args):  # silence default access logging
        pass


def main():
    if not (NM3U8 or YTDLP or FFMPEG):
        log("WARNING: no downloader (N_m3u8DL-RE / yt-dlp / ffmpeg) on PATH; downloads will fail")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("listening on http://127.0.0.1:%d  (out=%s, N_m3u8DL-RE=%s, yt-dlp=%s, ffmpeg=%s)"
        % (PORT, OUT, bool(NM3U8), bool(YTDLP), bool(FFMPEG)))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        srv.shutdown()


if __name__ == "__main__":
    main()
