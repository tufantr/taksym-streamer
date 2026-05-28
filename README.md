# Taksym 24/7 streamer

RTMP encoder + multi-platform chat bot for the always-on music stream powering [taksym.com](https://www.taksym.com). Reads the live catalog, encodes each track with FFmpeg, and pushes one stream to Twitch, YouTube, and Kick simultaneously via the `tee` muxer.

This is a deployment-only repo — the main Next.js app lives separately. The streamer pulls catalog data over HTTPS like any other API consumer.

## Quick start (VPS)

```bash
# As root on a fresh Ubuntu 24.04+ box:
curl -sSL https://raw.githubusercontent.com/tufantr/taksym-streamer/main/install.sh | sudo bash

# Fill in your stream keys + chat tokens:
nano /opt/taksym/.env

# Go live:
cd /opt/taksym && docker compose up -d
docker compose logs -f      # watch first minute, Ctrl+C to detach
```

## The 5 commands you'll actually use

| Command | When |
|---|---|
| `docker compose logs -f` | "Is something wrong?" — tails live logs |
| `docker compose ps` | "Is it still running?" |
| `docker compose restart` | After tweaking `.env` |
| `docker compose down` | Stop everything |
| `docker compose up -d` | Start it back |

All run from `/opt/taksym`.

## Updating after code changes

From your laptop, push code. On the VPS:

```bash
cd /opt/taksym && git pull && docker compose up -d --build
```

~30 seconds of dead air during the rebuild.

## DMCA / track blocklist

If a track gets flagged on Twitch:

```bash
echo "<track-id-key>" >> /opt/taksym/flaggedTracks.txt
docker compose restart stream
```

The track is skipped on every subsequent loop.

## Resource ceiling

`docker-compose.yml` caps the encoder at 0.85 CPU / 700 MB RAM and the chat bot at 0.10 CPU / 200 MB. Designed for a 1 vCPU / 1 GB Vultr instance.

## Why each piece exists

- **stream.mjs** — Node orchestrator. Loops the catalog, spawns one FFmpeg invocation per track, writes current track to a shared state file.
- **chat-bot.mjs** — Connects to Twitch IRC, Kick chat WebSocket, and YouTube Live Chat API. Reads the state file for `!song` replies, calls the live `/api/mood-mix` for `!mix`.
- **lib/state.mjs** — Atomic JSON file IPC between the two services.
- **lib/overlay.mjs** — Cover art caching + QR code generation.
- **lib/catalog.mjs** — Periodic re-fetch of the catalog (15 min TTL), so new tracks shipped to taksym.com land in the rotation automatically.
