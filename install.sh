#!/usr/bin/env bash
#
# MediaSniff one-shot installer (cross-distro Linux).
#
# Installs the HLS engine (N_m3u8DL-RE), builds the extension, and registers the
# Grab helper as an autostart systemd user service so the whole stack works after
# a single run. Distro-agnostic (Debian/Ubuntu, Fedora, Arch, openSUSE, Alpine,
# Void, Gentoo…) and arch-aware (x64/arm64, glibc/musl). Idempotent.
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

# distro-aware "how to install <pkgs>" hint
pkg_cmd() {
  if   have apt-get;      then echo "sudo apt install $*"
  elif have dnf;          then echo "sudo dnf install $*"
  elif have pacman;       then echo "sudo pacman -S $*"
  elif have zypper;       then echo "sudo zypper install $*"
  elif have apk;          then echo "sudo apk add $*"
  elif have xbps-install; then echo "sudo xbps-install -S $*"
  elif have emerge;       then echo "sudo emerge $*"
  else echo "install with your package manager: $*"
  fi
}

# pick the N_m3u8DL-RE release-asset tag for this CPU + libc (e.g. linux-x64,
# linux-arm64, linux-musl-x64). Empty = no prebuilt binary for this arch.
nm_asset_pattern() {
  local a
  case "$(uname -m)" in
    x86_64|amd64)  a="x64"   ;;
    aarch64|arm64) a="arm64" ;;
    *)             a=""      ;;
  esac
  [ -z "$a" ] && { echo ""; return; }
  local libc="linux"
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then libc="linux-musl"; fi
  echo "${libc}-${a}"
}

mkdir -p "$BIN"
c_log "repo: $REPO"

# 1. required tools ----------------------------------------------------------
miss=()
for c in python3 curl tar; do have "$c" || miss+=("$c"); done
if [ "${#miss[@]}" -gt 0 ]; then
  c_err "missing required tools: ${miss[*]}"
  c_err "install them:  $(pkg_cmd "${miss[@]}")"
  exit 1
fi

# 2. download/mux tools ------------------------------------------------------
if have ffmpeg; then c_log "ffmpeg: ok"; else c_warn "ffmpeg missing — $(pkg_cmd ffmpeg)"; fi
if have yt-dlp; then c_log "yt-dlp: ok"; else c_warn "yt-dlp missing — $(pkg_cmd yt-dlp)   (or: python3 -m pip install --user -U yt-dlp)"; fi

# 3. vsd (Rust HLS/DASH engine — primary, faster startup) -------------------
if have vsd; then
  c_log "vsd: ok ($(command -v vsd))"
else
  c_log "installing vsd (Rust HLS/DASH engine) ..."
  vsd_api=$(curl -fsSL https://api.github.com/repos/chethan62/vsd/releases/latest || true)
  vsd_url=""
  if have jq; then
    vsd_url=$(printf '%s' "$vsd_api" | jq -r '[.assets[]|select(.name|test("linux-x64"))][0].browser_download_url' 2>/dev/null)
  fi
  if [ -z "$vsd_url" ] || [ "$vsd_url" = "null" ]; then
    vsd_url=$(printf '%s' "$vsd_api" | grep -oE "https://[^\"]*linux-x64[^\"]*" | head -1)
  fi
  if [ -n "$vsd_url" ] && [ "$vsd_url" != "null" ]; then
    if curl -fsSL -o /tmp/vsd.tar.gz "$vsd_url" && tar -xzf /tmp/vsd.tar.gz -C "$BIN" vsd && chmod +x "$BIN/vsd" && rm -f /tmp/vsd.tar.gz; then
      c_log "vsd installed -> $BIN/vsd"
    else
      c_warn "vsd download failed — HLS will fall back to N_m3u8DL-RE"
    fi
  else
    c_warn "no vsd binary for linux-x64 — HLS will fall back to N_m3u8DL-RE"
  fi
fi

# 4. N_m3u8DL-RE (HLS/DASH engine — fallback) -------------------------------
if have N_m3u8DL-RE; then
  c_log "N_m3u8DL-RE: ok ($(command -v N_m3u8DL-RE))"
else
  pat="$(nm_asset_pattern)"
  if [ -z "$pat" ]; then
    c_warn "no prebuilt N_m3u8DL-RE for $(uname -m) — HLS will fall back to yt-dlp"
  else
    c_log "installing N_m3u8DL-RE ($pat) ..."
    api=$(curl -fsSL https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest || true)
    url=""
    if have jq; then
      url=$(printf '%s' "$api" | jq -r --arg p "$pat" '[.assets[]|select(.name|test($p))][0].browser_download_url' 2>/dev/null)
    fi
    if [ -z "$url" ] || [ "$url" = "null" ]; then
      url=$(printf '%s' "$api" | grep -oE "https://[^\"]*${pat}[^\"]*\.tar\.gz" | head -1)
    fi
    if [ -z "$url" ]; then
      c_warn "could not resolve a $pat asset — HLS will fall back to yt-dlp"
    else
      wd=$(mktemp -d)
      if curl -fsSL -o "$wd/n.tgz" "$url" && tar -xzf "$wd/n.tgz" -C "$wd"; then
        binf=$(find "$wd" -type f -name 'N_m3u8DL-RE' | head -1)
        if [ -n "$binf" ]; then install -m755 "$binf" "$BIN/N_m3u8DL-RE"; c_log "installed -> $BIN/N_m3u8DL-RE"; else c_err "binary not found in archive"; fi
      else
        c_err "download/extract failed"
      fi
      rm -rf "$wd"
    fi
  fi
fi
case ":$PATH:" in *":$BIN:"*) : ;; *) c_warn "$BIN is not on your PATH — add it to your shell rc";; esac

# 4. build the extension -----------------------------------------------------
if have npm; then
  c_log "building extension ..."
  if ( cd "$REPO" && npm run build >/dev/null 2>&1 ); then c_log "built dist/ (chrome + firefox)"; else c_warn "build failed — Chromium can still load the repo root directly"; fi
else
  c_warn "npm not found — skipping Firefox build (Chromium loads the repo root directly). $(pkg_cmd nodejs npm)"
fi

# 5. helper autostart service (systemd; graceful fallback otherwise) ---------
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
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' | head -1)
  if [ -n "${pid:-}" ]; then c_warn "freeing port $PORT (pid $pid)"; kill "$pid" 2>/dev/null || true; sleep 1; fi
  systemctl --user enable --now "$SERVICE" 2>/dev/null || systemctl --user restart "$SERVICE"
  sleep 2
  if curl -fsS -m 4 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    c_log "helper UP: $(curl -fsS -m 4 "http://127.0.0.1:$PORT/health")"
  else
    c_warn "helper not responding on :$PORT — check: systemctl --user status $SERVICE"
  fi
else
  c_warn "no user systemd — autostart skipped. Run the helper manually (or add to your DE/init autostart):"
  c_warn "    python3 $REPO/helper/grab.py"
fi

# 6. ABDM (optional; DM button = direct files) -------------------------------
if ss -ltn 2>/dev/null | grep -q ':15151 '; then
  c_log "ABDM detected on :15151 (DM button ready)"
else
  c_warn "ABDM not running (optional — DM = direct files). Get it: https://abdownloadmanager.com"
fi

# 7. done --------------------------------------------------------------------
c_log "Backend ready. One manual step left — load the extension:"
cat <<EOF

  Chromium / Vivaldi / Brave:
    chrome://extensions  ->  enable Developer mode  ->  Load unpacked  ->  $REPO

  Then sniff a page and use Copy / Cmd / DM / Grab / Open:
    Grab -> HLS/DASH via N_m3u8DL-RE -> ~/Downloads  (live progress + Downloads panel)
    DM   -> direct files via AB Download Manager
  Manage the helper:  systemctl --user {status,restart,stop} $SERVICE   (autostarts on login)
EOF
