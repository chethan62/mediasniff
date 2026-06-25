#!/usr/bin/env bash
#
# MediaSniff bootstrap — clone (or update) the repo, then run the installer.
#
# One command (Linux):
#   bash <(curl -fsSL https://raw.githubusercontent.com/chethan62/mediasniff/main/bootstrap.sh)
#
# Env: MEDIASNIFF_DIR  where to clone (default ~/softwears/mediasniff)
#
set -uo pipefail

REPO_URL="https://github.com/chethan62/mediasniff.git"
DEST="${MEDIASNIFF_DIR:-$HOME/softwears/mediasniff}"

log() { printf '\033[1;36m[mediasniff]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[mediasniff] ERR:\033[0m %s\n' "$*" >&2; }

command -v git >/dev/null 2>&1 || { err "git is required — install it first, then re-run."; exit 1; }

if [ -d "$DEST/.git" ]; then
  log "updating existing checkout: $DEST"
  git -C "$DEST" pull --ff-only || log "pull skipped (local changes) — using current checkout"
else
  log "cloning into: $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 "$REPO_URL" "$DEST" || { err "clone failed"; exit 1; }
fi

log "running installer ..."
exec bash "$DEST/install.sh"
