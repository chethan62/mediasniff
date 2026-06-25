#!/usr/bin/env bash
#
# MediaSniff one-shot installer.
#
# Installs the HLS engine (N_m3u8DL-RE), builds the extension, and registers the
# Grab helper as an autostart systemd user service so the whole stack works after
# a single run. Idempotent — safe to re-run.
#
# Usage:  bash install.sh        (run from anywhere; it resolves its own path)
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
SERVICE="mediasniff-grabber"
PORT="${MEDIASNIFF_PORT:-15152}"

c_log()  { printf '\033[1;36m[mediasniff]\033[0m %s\n' "$*"; }
c_warn() { printf '\033[1;33m[mediasniff] WARN:\033[0m %s\n' "$*"; }
c_err()  { printf '\033[1;31m[mediasniff] ERR:\033[0m %s\n'  "$*" >&2; }
have()   { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$BIN"
c_log "repo: $REPO"

# --- 1. required tools -------------------------------------------------------
miss=()
for c in python3 curl tar; do have "$c" || miss+=("$c"); done
if [ "${#miss[@]}" -gt 0 ]; then
  c_err "missing required tools: ${miss[*]}   (Arch: sudo pacman -S python curl tar)"
  exit 1
fi

# --- 2. download/mux tools (helper fallbacks; ffmpeg also muxes for the engine)
for c in yt-dlp ffmpeg; do
  if have "$c"; then c_log "$c: ok"; else c_warn "$c missing — install it (Arch: sudo pacman -S $c)"; fi
done

# --- 3. N_m3u8DL-RE (HLS/DASH engine) ----------------------------------------
if have N_m3u8DL-RE; then
  c_log "N_m3u8DL-RE: ok ($(command -v N_m3u8DL-RE))"
else
  c_log "installing N_m3u8DL-RE (latest linux-x64) ..."
  api=$(curl -fsSL https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest || true)
  url=""
  if have jq; then
    url=$(printf '%s' "$api" | jq -r '[.assets[]|select(.name|test("linux-x64"))][0].browser_download_url' 2>/dev/null)
  fi
  if [ -z "$url" ] || [ "$url" = "null" ]; then
    url=$(printf '%s' "$api" | grep -oE 'https://[^"]*linux-x64[^"]*\.tar\.gz' | head -1)
  fi
  if [ -z "$url" ]; then
    c_err "could not resolve a N_m3u8DL-RE release asset (network/API issue)"; exit 1
  fi
  wd=$(mktemp -d)
  if curl -fsSL -o "$wd/n.tgz" "$url" && tar -xzf "$wd/n.tgz" -C "$wd"; then
    binf=$(find "$wd" -type f -name 'N_m3u8DL-RE' | head -1)
    if [ -n "$binf" ]; then install -m755 "$binf" "$BIN/N_m3u8DL-RE"; c_log "installed -> $BIN/N_m3u8DL-RE"; else c_err "binary not found in archive"; fi
  else
    c_err "download/extract failed"
  fi
  rm -rf "$wd"
fi
case ":$PATH:" in *":$BIN:"*) : ;; *) c_warn "$BIN is not on your PATH — add it to your shell rc";; esac

# --- 4. build the extension --------------------------------------------------
if have npm; then
  c_log "building extension ..."
  if ( cd "$REPO" && npm run build >/dev/null 2>&1 ); then c_log "built dist/ (chrome + firefox)"; else c_warn "build failed — Chromium can still load the repo root directly"; fi
else
  c_warn "npm not found — skipping Firefox build (Chromium loads the repo root directly)"
fi

# --- 5. helper autostart service --------------------------------------------
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  c_log "registering autostart service ($SERVICE) ..."
  unitdir="$HOME/.config/systemd/user"; mkdir -p "$unitdir"
  py="$(command -v python3)"
  cat > "$unitdir/$SERVICE.service" <<EOF
[Unit]
Description=MediaSniff Grabber — local HLS/DASH download helper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$py $REPO/helper/grab.py
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [ -n "$pid" ]; then c_warn "freeing port $PORT (pid $pid)"; kill "$pid" 2>/dev/null || true; sleep 1; fi
  systemctl --user enable --now "$SERVICE" 2>/dev/null || systemctl --user restart "$SERVICE"
  sleep 2
  if curl -fsS -m 4 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    c_log "helper UP: $(curl -fsS -m 4 "http://127.0.0.1:$PORT/health")"
  else
    c_warn "helper not responding on :$PORT — check: systemctl --user status $SERVICE"
  fi
else
  c_warn "no user systemd available — run the helper manually: python3 $REPO/helper/grab.py"
fi

# --- 6. ABDM (optional; DM button = direct files) ----------------------------
if ss -ltn 2>/dev/null | grep -q ':15151 '; then
  c_log "ABDM detected on :15151 (DM button ready)"
else
  c_warn "ABDM not running (optional — DM = direct files). Get it: https://abdownloadmanager.com"
fi

# --- done --------------------------------------------------------------------
c_log "Backend ready. One manual step left — load the extension:"
cat <<EOF

  Chromium / Vivaldi:
    chrome://extensions  ->  enable Developer mode  ->  Load unpacked  ->  $REPO

  Then sniff a page and use Copy / Cmd / DM / Grab / Open:
    Grab -> HLS/DASH via N_m3u8DL-RE -> ~/Downloads  (live progress + Downloads panel)
    DM   -> direct files via AB Download Manager
  Manage the helper:  systemctl --user {status,restart,stop} $SERVICE   (autostarts on login)
EOF
