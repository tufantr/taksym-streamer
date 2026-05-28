#!/usr/bin/env node
//
// Taksym 24/7 RTMP streamer (v3 — concat batching for live-detection).
//
// Why v3: streaming platforms only show a channel as LIVE when they see a
// stable RTMP connection that doesn't reconnect. v1 respawned FFmpeg per
// track (30s) — Kick saw the stream "flapping" every 30s and never lit up.
// v2 added too much (drawtext reload, complex filter graph) and stalled.
//
// v3 is the minimal change from v1 that keeps RTMP alive: one FFmpeg per
// BATCH of N tracks via the concat demuxer. One static brand background.
// One static URL wordmark. No per-frame disk I/O. The chat bot still
// shows the current track via state.json, but the visual overlay is
// fixed for the batch — simpler, much more reliable.
//
// Tradeoffs vs v1:
//   • Lose per-track cover art and per-track now-playing text in the
//     video overlay (chat bot's !song reply still has them)
//   • Gain: one continuous RTMP session per ~15 minutes, which platforms
//     recognise as a stable broadcast.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";

import { loadCatalog, shuffle } from "./lib/catalog.mjs";
import { writeState } from "./lib/state.mjs";
import { ffmpegEscape } from "./lib/overlay.mjs";

// ─── config ──────────────────────────────────────────────────────────────

const CFG = {
  twitchKey: process.env.TWITCH_STREAM_KEY ?? "",
  youtubeKey: process.env.YOUTUBE_STREAM_KEY ?? "",
  kickKey: process.env.KICK_STREAM_KEY ?? "",

  width: Number(process.env.STREAM_WIDTH ?? 1280),
  height: Number(process.env.STREAM_HEIGHT ?? 720),
  fps: Number(process.env.STREAM_FPS ?? 30),
  videoBitrate: process.env.STREAM_VBITRATE ?? "3500k",
  audioBitrate: process.env.STREAM_ABITRATE ?? "160k",
  preset: process.env.STREAM_PRESET ?? "ultrafast",

  brandUrl: process.env.BRAND_URL ?? "taksym.com",
  siteOrigin: process.env.SITE_ORIGIN ?? "https://www.taksym.com",
  fontFile:
    process.env.FONT_FILE ??
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",

  // Tracks per FFmpeg invocation. 30 × 30s ≈ 15 min per batch — plenty
  // of time for platforms to register the stream as stable.
  batchSize: Number(process.env.STREAM_BATCH_SIZE ?? 30),

  blocklistPath: process.env.BLOCKLIST_PATH ?? "/state/flaggedTracks.txt",
  statePath: process.env.STATE_PATH ?? "/state/stream-state.json",
  playlistPath: process.env.PLAYLIST_PATH ?? "/state/playlist.txt",
};

const kickIngest = process.env.KICK_RTMP_URL ?? "rtmps://fa723fc1b171.global-contribute.live-video.net/app";
const sinks = [
  CFG.twitchKey && `rtmp://live.twitch.tv/app/${CFG.twitchKey}`,
  CFG.youtubeKey && `rtmp://a.rtmp.youtube.com/live2/${CFG.youtubeKey}`,
  CFG.kickKey && `${kickIngest.replace(/\/$/, "")}/${CFG.kickKey}`,
].filter(Boolean);

if (sinks.length === 0) {
  console.error("No stream destinations configured");
  process.exit(1);
}

console.log(`streamer v3 up · destinations: ${sinks.length} · ${CFG.width}x${CFG.height}@${CFG.fps} · batch=${CFG.batchSize}`);

fs.mkdirSync(path.dirname(CFG.statePath), { recursive: true });

// ─── helpers ─────────────────────────────────────────────────────────────

function loadBlocklist() {
  try {
    return new Set(
      fs.readFileSync(CFG.blocklistPath, "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function absUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${CFG.siteOrigin}${url}`;
  return `${CFG.siteOrigin}/${url}`;
}

function getArtist(track) {
  return (track.vibe_description ?? "").split(" by ")[1]?.replace(".", "") ?? "Unknown";
}

function durationSeconds(track) {
  const m = (track.duration ?? "").match(/^(\d+):(\d+)$/);
  if (!m) return 30;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Write the concat playlist FFmpeg will read. The concat demuxer accepts
// remote http(s) URLs when `-safe 0` and `-protocol_whitelist` are set.
function writePlaylist(tracks) {
  const lines = [];
  for (const t of tracks) {
    const a = absUrl(t.audio_url);
    if (!a) continue;
    const escaped = a.replace(/'/g, "'\\''");
    lines.push(`file '${escaped}'`);
  }
  fs.writeFileSync(CFG.playlistPath, lines.join("\n") + "\n");
}

// Update state.json — chat bot reads this for !song.
function publishState(track) {
  if (!track) return;
  writeState({
    id: track.id_key,
    title: track.title ?? "Unknown",
    artist: getArtist(track),
    deepLink: `${CFG.siteOrigin}/t?to=${encodeURIComponent(`/track/${encodeURIComponent(track.id_key)}`)}`,
    startedAt: Date.now(),
  });
}

function ffmpegArgsForBatch() {
  const teeDest = sinks
    .map((s) => `[f=flv:flvflags=no_duration_filesize:onfail=ignore]${s}`)
    .join("|");

  // Static visual:
  //   • lavfi-generated dark navy background (no remote image fetch, no
  //     disk I/O — keeps the encode lightweight on a 1 vCPU box)
  //   • drawtext wordmark, lower-left (static text — no reload)
  //   • drawtext "AI music streaming" tagline, centered (static)
  const wordmark = ffmpegEscape(CFG.brandUrl);
  const tagline = ffmpegEscape("AI music streaming · 100+ genres");

  // Subtle pulse on the wordmark gives x264 something to encode every
  // frame — without motion, static lavfi color encodes at ~400 kbps which
  // some platforms filter as "non-live". sin() oscillation @ ~0.5 Hz.
  const filter = [
    `[0:v]drawtext=text='${tagline}':fontfile=${CFG.fontFile}:` +
      `fontsize=44:fontcolor=white@0.85:` +
      `x=(w-text_w)/2:y=(h-text_h)/2[mid]`,
    `[mid]drawtext=text='${wordmark}':fontfile=${CFG.fontFile}:` +
      `fontsize=42:fontcolor=white:` +
      `alpha='0.85+0.15*sin(2*PI*t/2)':` +
      `box=1:boxcolor=black@0.4:boxborderw=12:` +
      `x=32:y=H-th-32[v]`,
  ].join(";");

  return [
    "-hide_banner",
    "-loglevel", "warning",

    // Input 0: synthesised dark-navy background. lavfi auto-paces at
    // framerate, no -re needed.
    "-f", "lavfi",
    "-i", `color=c=#0a0d1a:s=${CFG.width}x${CFG.height}:r=${CFG.fps}`,

    // Input 1: audio playlist via concat demuxer. -re paces to wall-clock
    // so the RTMP push is real-time.
    "-re",
    "-f", "concat",
    "-safe", "0",
    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
    "-i", CFG.playlistPath,

    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "1:a",

    "-c:v", "libx264",
    "-preset", CFG.preset,
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-r", String(CFG.fps),
    "-g", String(CFG.fps * 2),
    "-b:v", CFG.videoBitrate,
    "-maxrate", CFG.videoBitrate,
    "-bufsize", `${parseInt(CFG.videoBitrate) * 2}k`,

    "-c:a", "aac",
    "-b:a", CFG.audioBitrate,
    "-ar", "44100",
    "-ac", "2",

    "-shortest",

    "-f", "tee",
    teeDest,
  ];
}

// ─── orchestration ─────────────────────────────────────────────────────

let stopping = false;
let current = null;

process.on("SIGTERM", () => { stopping = true; current?.kill("SIGTERM"); });
process.on("SIGINT",  () => { stopping = true; current?.kill("SIGINT");  });

async function runBatch(tracks) {
  writePlaylist(tracks);
  publishState(tracks[0]);

  // Schedule state updates for subsequent tracks using cumulative offsets.
  // Audio plays in real-time so wall-clock timers stay in sync.
  let elapsed = 0;
  const timers = [];
  for (let i = 0; i < tracks.length - 1; i++) {
    elapsed += durationSeconds(tracks[i]);
    const next = tracks[i + 1];
    timers.push(setTimeout(() => publishState(next), elapsed * 1000));
  }

  const estMin = Math.round(tracks.reduce((s, t) => s + durationSeconds(t), 0) / 60);
  console.log(`▶ batch · ${tracks.length} tracks · est ${estMin}min`);

  return new Promise((resolve) => {
    current = spawn("ffmpeg", ffmpegArgsForBatch(), {
      stdio: ["ignore", "inherit", "inherit"],
    });
    current.on("exit", (code, signal) => {
      timers.forEach(clearTimeout);
      current = null;
      console.log(`  ↳ batch ended (code=${code} signal=${signal ?? "-"})`);
      resolve(code);
    });
  });
}

async function main() {
  while (!stopping) {
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch (err) {
      console.error("catalog load failed, retry 30s:", err.message);
      await sleep(30_000);
      continue;
    }
    const blocklist = loadBlocklist();
    const pool = shuffle(catalog).filter((t) => !blocklist.has(t.id_key) && t.audio_url);
    if (pool.length === 0) {
      console.error("no playable tracks — sleep 60s");
      await sleep(60_000);
      continue;
    }
    for (let i = 0; i < pool.length && !stopping; i += CFG.batchSize) {
      const batch = pool.slice(i, i + CFG.batchSize);
      try {
        await runBatch(batch);
      } catch (err) {
        console.error("batch error:", err.message);
        await sleep(3_000);
      }
    }
  }
  console.log("streamer stopped");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
