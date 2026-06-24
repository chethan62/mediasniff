#!/usr/bin/env python3
"""
MediaSniff Grabber — a tiny local helper that downloads HLS/DASH (or direct)
media URLs sniffed by the MediaSniff browser extension, with job tracking
so the extension can show real progress instead of fire-and-forget.

Features (v1.5 — job tracking, progress, quality picker, subs):
    POST /grab   {url,referer,userAgent,format?,subs?,audioUrl?}
                 → 202 {"ok":true,"started":true,"id":<int>}
    GET  /jobs                   → {"ok":true,"jobs":[{id,url,status,pct,file}]}
    GET  /status/<id>            → {"ok":true,"id":…,"status":"done"|"failed"|"downloading","pct":…,"file":"…"}
    GET  /health                 → {"ok":true,"ytdlp":bool,"ffmpeg":bool,"out":"…"}

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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("MEDIASNIFF_PORT", "15152"))
OUT = os.path.expanduser(os.environ.get("MEDIASNIFF_OUT", "~/Downloads"))
UA_DEFAULT = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"

YTDLP = shutil.which("yt-dlp")
FFMPEG = shutil.which("ffmpeg")

jobs = {}          # id → {url, referer, userAgent, format, subs, audioUrl, status, pct, file, error}
_next_id = 1
SAFE_JOB_KEYS = {"url", "status", "pct", "file", "error", "format", "subs"}

PERCENT_RE = re.compile(r"([\d.]+)%")
DEST_RE = re.compile(r"Destination:\s*(.+)")


def log(*a):
    print("[grabber]", *a, flush=True)


def _stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def run_download(job_id):
    job = jobs[job_id]
    url = job.get("url")
    referer = job.get("referer") or ""
    ua = job.get("userAgent") or UA_DEFAULT
    audio = job.get("audioUrl") or ""
    fmt = job.get("format") or ""
    subs = job.get("subs", False)
    os.makedirs(OUT, exist_ok=True)
    job["status"] = "downloading"
    job["pct"] = 0
    try:
        if audio and FFMPEG:
            # explicit video + audio variant mux (master expired / split renditions).
            out = os.path.join(OUT, "mediasniff_%s.mp4" % _stamp())
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", url,
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", audio,
                   "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", out]
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
            cmd += ["-o", os.path.join(OUT, "%(title).150B_[%(id)s].%(ext)s"), url]
        elif FFMPEG:
            out = os.path.join(OUT, "mediasniff_%s.mp4" % _stamp())
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer,
                   "-i", url, "-c", "copy", out]
        else:
            job["status"] = "failed"
            job["error"] = "neither yt-dlp nor ffmpeg found"
            return

        log("START", os.path.basename(cmd[0]), "->", url[:90])
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        for line in p.stdout or []:
            m = PERCENT_RE.search(line)
            if m:
                job["pct"] = float(m.group(1))
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
            job["error"] = "exit %d" % p.returncode
        log("DONE rc=%d" % p.returncode, url[:90])
    except Exception as e:  # noqa: BLE001
        job["status"] = "failed"
        job["error"] = str(e)[:300]
        log("EXC", repr(e))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

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
                "ok": True, "ytdlp": bool(YTDLP), "ffmpeg": bool(FFMPEG), "out": OUT
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
        if urlparse(self.path).path != "/grab":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"ok": False, "error": "bad json: %s" % e})
        if not data.get("url"):
            return self._json(400, {"ok": False, "error": "missing url"})
        if not (YTDLP or FFMPEG):
            return self._json(500, {"ok": False, "error": "yt-dlp/ffmpeg not installed"})

        global _next_id
        jid = _next_id
        _next_id += 1
        jobs[jid] = {
            "url": data["url"],
            "referer": data.get("referer", ""),
            "userAgent": data.get("userAgent", "") or UA_DEFAULT,
            "format": data.get("format", ""),
            "subs": data.get("subs", False),
            "audioUrl": data.get("audioUrl", ""),
            "status": "queued",
            "pct": 0,
        }
        threading.Thread(target=run_download, args=(jid,), daemon=True).start()
        return self._json(202, {"ok": True, "started": True, "id": jid})

    def log_message(self, format, *args):  # silence default access logging
        pass


def main():
    if not (YTDLP or FFMPEG):
        log("WARNING: neither yt-dlp nor ffmpeg on PATH; downloads will fail")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log("listening on http://127.0.0.1:%d  (out=%s, yt-dlp=%s, ffmpeg=%s)"
        % (PORT, OUT, bool(YTDLP), bool(FFMPEG)))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        srv.shutdown()


if __name__ == "__main__":
    main()
