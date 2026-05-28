#!/usr/bin/env node
//
// Taksym 24/7 RTMP streamer.
//
// Architecture (v2 — built for platform "live" detection):
//
//   Streaming platforms only show a channel as LIVE when they see a stable,
//   continuous RTMP connection. Our first attempt re-spawned FFmpeg per
//   track — Kick saw the stream "flapping" every 30s and never lit up.
//
//   v2 uses ONE long-running FFmpeg per batch of ~25 minutes. Audio inputs
//   are concatenated via the concat demuxer; one RTMP connection covers
//   the whole batch. When the batch ends, we immediately spawn the next.
//   Between-batch gap is ~1s — well inside Kick/Twitch's "drop tolerance".
//
//   Tradeoff vs v1: per-track cover art is replaced with one brand-mark
//   background. Now-playing text still updates by writing each track's
//   metadata to a sidecar file that FFmpeg's `drawtext reload=1` re-reads
//   every frame.
//
// State (chat bot reads this for !song):
//   `/state/stream-state.json` — { id, title, artist, deepLink, startedAt }
// Now-playing overlay source:
//   `/state/nowplaying.txt` — single line "Title — Artist"

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";

import { loadCatalog, shuffle } from "./lib/catalog.mjs";
import { writeState } from "./lib/state.mjs";

// ─── config ──────────────────────────────────────────────────────────────

const CFG = {
  twitchKey: process.env.TWITCH_STREAM_KEY ?? "",
  youtubeKey: process.env.YOUTUBE_STREAM_KEY ?? "",
  kickKey: process.env.KICK_STREAM_KEY ?? "",

  // Encoding
  width: Number(process.env.STREAM_WIDTH ?? 1280),
  height: Number(process.env.STREAM_HEIGHT ?? 720),
  fps: Number(process.env.STREAM_FPS ?? 30),
  videoBitrate: process.env.STREAM_VBITRATE ?? "3500k",
  audioBitrate: process.env.STREAM_ABITRATE ?? "160k",
  preset: process.env.STREAM_PRESET ?? "ultrafast",

  // Brand
  brandUrl: process.env.BRAND_URL ?? "taksym.com",
  siteOrigin: process.env.SITE_ORIGIN ?? "https://www.taksym.com",
  fontFile:
    process.env.FONT_FILE ??
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",

  // Batching — how many tracks per FFmpeg invocation. 30 tracks at ~30s
  // each ≈ 15 minutes per batch. Long enough for Kick to register us as
  // a stable broadcaster; short enough that any FFmpeg-level corruption
  // is bounded.
  batchSize: Number(process.env.STREAM_BATCH_SIZE ?? 30),

  // Optional blocklist (one track id per line) for DMCA / hand-flagged.
  blocklistPath: process.env.BLOCKLIST_PATH ?? "/state/flaggedTracks.txt",

  // Where to write nowplaying.txt + the concat playlist. Mounted as a
  // docker volume in the compose file so the chat bot can read state.
  statePath: process.env.STATE_PATH ?? "/state/stream-state.json",
  npPath: process.env.NP_PATH ?? "/state/nowplaying.txt",
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

console.log(`streamer v2 up · destinations: ${sinks.length} · ${CFG.width}x${CFG.height}@${CFG.fps} · batch=${CFG.batchSize}`);

// Ensure state dir exists.
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

// Write the concat playlist FFmpeg will read. The concat demuxer accepts
// remote http(s) URLs when `-safe 0` is set.
function writePlaylist(tracks) {
  const lines = [];
  for (const t of tracks) {
    const a = absUrl(t.audio_url);
    if (!a) continue;
    // Single-quote-escape filenames in concat list. Internal apostrophes
    // are written as '\'' per ffmpeg docs.
    const escaped = a.replace(/'/g, "'\\''");
    lines.push(`file '${escaped}'`);
  }
  fs.writeFileSync(CFG.playlistPath, lines.join("\n") + "\n");
}

function ffmpegEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

// Build the FFmpeg argv. One process, many tracks, one RTMP push to each
// sink via the `tee` muxer.
function ffmpegArgsForBatch() {
  const teeDest = sinks
    .map((s) => `[f=flv:flvflags=no_duration_filesize:onfail=ignore]${s}`)
    .join("|");

  const fontFile = CFG.fontFile;
  const wordmark = ffmpegEscape(CFG.brandUrl);

  // Filter graph:
  //   [0:v]  brand background → scale to stream size, slow Ken-Burns zoom
  //   drawtext wordmark bottom-left
  //   drawtext now-playing bottom-center, reload=1 picks up file changes
  //     between frames (so when we rewrite nowplaying.txt the overlay
  //     updates automatically at the next frame).
  const filter = [
    `[0:v]scale=${CFG.width * 1.2}:${CFG.height * 1.2}:force_original_aspect_ratio=increase,` +
      `crop=${CFG.width}:${CFG.height},` +
      `zoompan=z='min(zoom+0.0004,1.10)':d=1:s=${CFG.width}x${CFG.height}:fps=${CFG.fps}[bg]`,
    `[bg]drawtext=text='${wordmark}':fontfile=${fontFile}:` +
      `fontsize=42:fontcolor=white:` +
      `box=1:boxcolor=black@0.35:boxborderw=10:` +
      `x=32:y=H-th-32[wm]`,
    `[wm]drawtext=textfile=${CFG.npPath}:reload=1:fontfile=${fontFile}:` +
      `fontsize=28:fontcolor=white:` +
      `box=1:boxcolor=black@0.55:boxborderw=14:` +
      `x=(w-text_w)/2:y=H-th-110[v]`,
  ].join(";");

  // Brand background image lives in the image bundled with the streamer
  // repo (an Apple-icon style mark we ship in `/app/brand.png`). Falls
  // back to a solid color if the file is missing.
  const brandImg = fs.existsSync("/app/brand.png") ? "/app/brand.png" : null;

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-re",
  ];

  if (brandImg) {
    args.push("-loop", "1", "-i", brandImg);
  } else {
    // Synthesised gradient as fallback.
    args.push("-f", "lavfi", "-i", `color=c=#0a0d1a:s=${CFG.width}x${CFG.height}:r=${CFG.fps}`);
  }

  args.push(
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

    // The video input (looped image) is infinite. The audio input
    // (concat list) is finite. `-shortest` stops at audio end — i.e.
    // when the batch playlist finishes.
    "-shortest",

    "-f", "tee",
    teeDest,
  );

  return args;
}

// ─── orchestration ─────────────────────────────────────────────────────

let stopping = false;
let current = null;

process.on("SIGTERM", () => { stopping = true; current?.kill("SIGTERM"); });
process.on("SIGINT",  () => { stopping = true; current?.kill("SIGINT");  });

// Update the now-playing overlay + state file. Called by the timer that
// runs alongside the FFmpeg batch — Node knows each track's duration so
// it can drive the overlay in sync with the audio.
function setNowPlaying(track) {
  if (!track) return;
  const title = track.title ?? "Unknown";
  const artist = getArtist(track);
  fs.writeFileSync(CFG.npPath, `Now playing: ${title} — ${artist}\n`);
  writeState({
    id: track.id_key,
    title,
    artist,
    deepLink: `${CFG.siteOrigin}/t?to=${encodeURIComponent(`/track/${encodeURIComponent(track.id_key)}`)}`,
    startedAt: Date.now(),
  });
}

// Parse "M:SS" durations from the catalog into seconds. Defaults to 30s
// when the catalog doesn't have a duration (avoids over-running the
// overlay; FFmpeg will sync to the actual file).
function durationSeconds(track) {
  const m = (track.duration ?? "").match(/^(\d+):(\d+)$/);
  if (!m) return 30;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function runBatch(tracks) {
  writePlaylist(tracks);
  // Seed the overlay with the first track and schedule transitions for
  // subsequent ones using their cumulative offsets.
  setNowPlaying(tracks[0]);
  let elapsed = 0;
  const timers = [];
  for (let i = 0; i < tracks.length - 1; i++) {
    elapsed += durationSeconds(tracks[i]);
    const next = tracks[i + 1];
    const t = setTimeout(() => setNowPlaying(next), elapsed * 1000);
    timers.push(t);
  }

  console.log(`▶ batch · ${tracks.length} tracks · est ${Math.round(tracks.reduce((s, t) => s + durationSeconds(t), 0) / 60)}min`);

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
    // Slice into batches of CFG.batchSize and stream each as one FFmpeg
    // session. RTMP stays connected for the whole batch.
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
