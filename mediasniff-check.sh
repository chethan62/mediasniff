#!/usr/bin/env bash
# mediasniff-check: self-healing + status check for MediaSniff
# Restores repo, rebuilds extension, installs missing tools, fixes service, runs health + download test.
set -euo pipefail

REPO="https://github.com/chethan62/mediasniff.git"
DIR="/home/chethan/softwears/mediasniff-firefox"
BIN="${HOME}/.local/bin"
GRABBER_PORT=15152
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ERRS=0

info() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[FIX]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; ERRS=$((ERRS+1)); }

mkdir -p "$BIN"

# 1. Ensure repo exists
if [ ! -f "$DIR/lib/media.js" ]; then
    warn "repo missing → restoring from GitHub"
    rm -rf "$DIR"
    git clone "$REPO" "$DIR"
fi
cd "$DIR"

# 2. Pull latest
warn "checking for updates ..."
git pull --ff-only 2>/dev/null || warn "could not pull (offline?)"

# 3. Rebuild extension
warn "rebuilding extension ..."
npm install --silent 2>/dev/null || true
npm run build 2>/dev/null || warn "npm build failed"

# 4. Ensure required binaries
download_vsd() {
    local api url
    api=$(curl -fsSL https://api.github.com/repos/chethan62/vsd/releases/latest 2>/dev/null || true)
    if command -v jq >/dev/null 2>&1; then
        url=$(printf '%s' "$api" | jq -r '[.assets[]|select(.name|test("linux-x64"))][0].browser_download_url' 2>/dev/null)
    else
        url=$(printf '%s' "$api" | grep -oE 'https://[^"]*linux-x64[^"]*' | head -1)
    fi
    printf '%s' "$url"
}

for tool in vsd N_m3u8DL-RE yt-dlp ffmpeg; do
    if command -v "$tool" >/dev/null 2>&1; then
        info "$tool: $(command -v $tool)"
    else
        warn "$tool missing"
        case "$tool" in
            vsd)
                URL=$(download_vsd)
                if [ -n "$URL" ] && [ "$URL" != "null" ]; then
                    curl -fsSL "$URL" -o /tmp/vsd.tar.gz
                    tar -xzf /tmp/vsd.tar.gz -C "$BIN" vsd 2>/dev/null
                    chmod +x "$BIN/vsd" && rm -f /tmp/vsd.tar.gz
                    info "vsd installed → $BIN/vsd"
                else
                    err "could not auto-install vsd (no release asset found)"
                fi
                ;;
            yt-dlp)
                if command -v pipx >/dev/null 2>&1; then pipx install yt-dlp 2>/dev/null && info "yt-dlp installed via pipx"
                elif python3 -m pip install --user -U yt-dlp 2>/dev/null; then info "yt-dlp installed via pip"
                else err "could not auto-install yt-dlp"
                fi
                ;;
            N_m3u8DL-RE)
                warn "N_m3u8DL-RE requires .NET SDK — install manually from chethan62/N_m3u8DL-RE"
                ;;
            ffmpeg)
                warn "ffmpeg required — install via your package manager (pacman -S ffmpeg)"
                ;;
        esac
    fi
done

# 5. Grabber service
UNIT="${HOME}/.config/systemd/user/mediasniff-grabber.service"
NEEDS_RESTART=0

if [ ! -f "$UNIT" ]; then
    warn "service unit missing → creating"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<EOF
[Unit]
Description=MediaSniff Grabber — local HLS/DASH download helper
After=network.target

[Service]
ExecStart=/usr/bin/python3 ${DIR}/helper/grab.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    NEEDS_RESTART=1
else
    # Fix path if grab.py moved
    if ! grep -q "${DIR}/helper/grab.py" "$UNIT"; then
        warn "fixing grabber service path"
        sed -i "s|/home/.*/grab.py|${DIR}/helper/grab.py|" "$UNIT"
        NEEDS_RESTART=1
    fi
fi

# Restart if not running or path was fixed
if ! systemctl --user is-active mediasniff-grabber >/dev/null 2>&1 || [ "$NEEDS_RESTART" = "1" ]; then
    warn "grabber not running → starting"
    systemctl --user daemon-reload
    systemctl --user enable mediasniff-grabber 2>/dev/null || true
    systemctl --user restart mediasniff-grabber
    sleep 2
fi

# 6. Health check
echo ""
echo "=== Health ==="
if curl -fsSL "http://127.0.0.1:${GRABBER_PORT}/health" >/dev/null 2>&1; then
    curl -s "http://127.0.0.1:${GRABBER_PORT}/health" | python3 -m json.tool
else
    err "grabber not responding on port ${GRABBER_PORT}"
    journalctl --user -u mediasniff-grabber --no-pager -n 10 2>/dev/null || true
fi

# 7. Test download (non-blocking — just start it)
echo ""
echo "=== Test Download ==="
RESP=$(curl -s -X POST "http://127.0.0.1:${GRABBER_PORT}/grab" \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://youtu.be/jNQXAC9IVRw","name":"heal-test"}' 2>/dev/null || echo '')
if [ -n "$RESP" ]; then
    ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo '')
    if [ -n "$ID" ]; then
        info "test download started (job $ID)"
    else
        err "test download failed: $RESP"
    fi
else
    err "grabber not responding"
fi

# 8. Summary
echo ""
echo "=== Summary ==="
if [ "$ERRS" = "0" ]; then
    info "MediaSniff is healthy"
else
    err "$ERRS issue(s) found"
fi

echo ""
echo "Manual steps:"
echo "  Chrome/Brave/Vivaldi: chrome://extensions → Developer mode → Load unpacked → $DIR/dist/chrome"
echo "  Firefox: about:debugging → This Firefox → Load temporary add-on → $DIR/dist/firefox/manifest.json"
echo "  Signed XPI: $DIR/web-ext-artifacts/*.xpi"

exit $ERRS
