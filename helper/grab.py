#!/usr/bin/env python3
"""
MediaSniff Grabber — a tiny local helper that downloads HLS/DASH (or direct)
media URLs sniffed by the MediaSniff browser extension.

The extension can't run yt-dlp/ffmpeg itself, so the "Grab" button POSTs the
URL (+ captured Referer/User-Agent) here and this service runs the download
*outside* the browser. yt-dlp resolves the variant ladder + muxes automatically
when given a fresh master playlist.

Run:
    python3 helper/grab.py
    # listens on http://127.0.0.1:15152  (localhost only)

Env:
    MEDIASNIFF_PORT   listen port           (default 15152)
    MEDIASNIFF_OUT    output directory      (default ~/Downloads)

Endpoints:
    GET  /health  -> {"ok":true,"ytdlp":bool,"ffmpeg":bool,"out":"..."}
    POST /grab    -> body {"url","referer","userAgent","audioUrl"?,"name"?}
                     returns 202 {"ok":true,"started":true}; the download runs
                     in the background and the file lands in MEDIASNIFF_OUT.

Security: binds 127.0.0.1 only. Any local process can POST to it, so don't run
it on a shared/multi-user machine without adding auth.
"""
import datetime
import json
import os
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


def log(*a):
    print("[grabber]", *a, flush=True)


def _stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def run_download(job):
    url = job.get("url")
    referer = job.get("referer") or ""
    ua = job.get("userAgent") or UA_DEFAULT
    audio = job.get("audioUrl") or ""
    os.makedirs(OUT, exist_ok=True)
    try:
        if audio and FFMPEG:
            # Explicit video + audio variant mux (e.g. master expired / split renditions).
            out = os.path.join(OUT, "mediasniff_%s.mp4" % _stamp())
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", url,
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer, "-i", audio,
                   "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", out]
        elif YTDLP:
            cmd = [YTDLP, "--no-warnings", "-N", "8", "--restrict-filenames",
                   "--merge-output-format", "mp4", "--user-agent", ua]
            if referer:
                cmd += ["--referer", referer]
            cmd += ["-o", os.path.join(OUT, "%(title).150B_[%(id)s].%(ext)s"), url]
        elif FFMPEG:
            out = os.path.join(OUT, "mediasniff_%s.mp4" % _stamp())
            cmd = [FFMPEG, "-y", "-loglevel", "warning",
                   "-user_agent", ua, "-headers", "Referer: %s\r\n" % referer,
                   "-i", url, "-c", "copy", out]
        else:
            log("ERROR: neither yt-dlp nor ffmpeg found on PATH")
            return
        log("START", os.path.basename(cmd[0]), "->", url[:90])
        rc = subprocess.call(cmd)
        log("DONE rc=%s" % rc, url[:90])
    except Exception as e:  # noqa: BLE001
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
        if urlparse(self.path).path == "/health":
            self._json(200, {"ok": True, "ytdlp": bool(YTDLP), "ffmpeg": bool(FFMPEG), "out": OUT})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/grab":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            job = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"ok": False, "error": "bad json: %s" % e})
        if not job.get("url"):
            return self._json(400, {"ok": False, "error": "missing url"})
        if not (YTDLP or FFMPEG):
            return self._json(500, {"ok": False, "error": "yt-dlp/ffmpeg not installed"})
        threading.Thread(target=run_download, args=(job,), daemon=True).start()
        return self._json(202, {"ok": True, "started": True})

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
