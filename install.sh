#!/usr/bin/env bash
#
# One-shot installer for the Taksym streamer on a fresh Ubuntu 24.04+ VPS.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/tufantr/taksym-streamer/main/install.sh | sudo bash
#
# What it does:
#   • Installs Docker + Docker Compose plugin
#   • Clones the repo into /opt/taksym (if not already there)
#   • Copies .env.example to /opt/taksym/.env (you fill in keys)
#   • Builds the streamer image
#   • Does NOT auto-start — you fill in .env, then run `docker compose up -d`

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tufantr/taksym-streamer.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/taksym}"

# Run as root or via sudo. Plain user without sudo will fail at apt later.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "must run as root (or with sudo)" >&2
  exit 1
fi

echo "==> apt update + base deps"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "==> cloning repo to $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

if [[ ! -f .env ]]; then
  echo "==> creating .env from template"
  cp .env.example .env
  chmod 600 .env
fi

echo "==> building Docker image"
docker compose build

cat <<EOF

==============================================================
Taksym streamer installed at $INSTALL_DIR
--------------------------------------------------------------

Next steps:

  1. Edit the .env file with your stream keys + chat tokens:
       nano $INSTALL_DIR/.env

  2. Start the stream + chat bot:
       cd $INSTALL_DIR && docker compose up -d

  3. Tail the logs (Ctrl+C to detach, stream keeps running):
       docker compose logs -f

  4. Stop everything:
       docker compose down

==============================================================
EOF
