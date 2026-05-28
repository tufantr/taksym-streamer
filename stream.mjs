#!/usr/bin/env node
//
// Taksym 24/7 RTMP streamer. Iterates through the catalog, encodes each
// track with FFmpeg, and pushes a single H.264/AAC stream simultaneously
// to Twitch, YouTube, and Kick via the `tee` muxer.
//
// Designed for low-spec VPS hosts (1 vCPU / 1 GB RAM):
//   • 720p30 ultrafast + `tune=stillimage` — H.264 loves looping covers
//   • cover image cached on disk per track, not re-fetched
//   • single encode → tee'd to 3 sinks → bandwidth is what it is, but
//     CPU is paid once
//
// Each track gets a fresh:
//   • Ken-Burns zoom on its cover art
//   • "taksym.com" wordmark bottom-left
//   • Now-playing text bottom-center
//   • QR code top-right linking to /track/<id> via /t for UTM
//
// State is mirrored to a JSON file (lib/state.mjs) so the chat bot can
// read the current track for `!song` replies.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";

import { loadCatalog, shuffle } from "./lib/catalog.mjs";
import { writeState } from "./lib/state.mjs";
import { makeQRPng, fetchCover, ffmpegEscape, TMP_DIR } from "./lib/overlay.mjs";

// ─── config ──────────────────────────────────────────────────────────────

const CFG = {
  // Stream keys (required, at least one)
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

  // Font for overlay text. Bundled with most Ubuntu installs; fall back
  // to a system font if not present.
  fontFile:
    process.env.FONT_FILE ??
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",

  // Optional blocklist file (track IDs the stream should skip — e.g.
  // after a DMCA flag). One id per line.
  blocklistPath: process.env.BLOCKLIST_PATH ?? "./flaggedTracks.txt",
};

// Twitch + YouTube ingest URLs are stable and well-known. Kick uses a
// per-account RTMP URL that's printed in the Stream URL & Key dashboard
// page — pass it via KICK_RTMP_URL alongside KICK_STREAM_KEY.
const kickIngest = process.env.KICK_RTMP_URL ?? "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app";

const sinks = [
  CFG.twitchKey && `rtmp://live.twitch.tv/app/${CFG.twitchKey}`,
  CFG.youtubeKey && `rtmp://a.rtmp.youtube.com/live2/${CFG.youtubeKey}`,
  CFG.kickKey && `${kickIngest.replace(/\/$/, "")}/${CFG.kickKey}`,
].filter(Boolean);

if (sinks.length === 0) {
  console.error("No stream destinations configured. Set TWITCH_STREAM_KEY, YOUTUBE_STREAM_KEY, and/or KICK_STREAM_KEY.");
  process.exit(1);
}

console.log(`streamer up · destinations: ${sinks.length} · ${CFG.width}x${CFG.height}@${CFG.fps}`);

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

function ffmpegArgsForTrack({ audioUrl, coverPath, qrPath, title, artist }) {
  // Build the `tee` muxer destinations string. flvflags=no_duration_filesize
  // is required for FLV streaming so RTMP doesn't try to seek.
  const teeDest = sinks
    .map((s) => `[f=flv:flvflags=no_duration_filesize:onfail=ignore]${s}`)
    .join("|");

  // FFmpeg drawtext params — escape user-controlled strings.
  const wordmark = ffmpegEscape(CFG.brandUrl);
  const nowPlaying = ffmpegEscape(`Now playing: ${title} — ${artist}`);
  const fontFile = CFG.fontFile;

  // Filter graph:
  //   [0:v]  cover image (looped) → scale + Ken-Burns zoompan → label [bg]
  //   [1:v]  QR PNG → scale → label [qr]
  //   [bg][qr] overlay (top-right corner) → drawtext wordmark + nowplaying
  //
  // The zoompan filter slowly zooms in over 30s (900 frames at 30fps),
  // then resets — creates "alive" feel without burning CPU on real motion.
  const filter = [
    // Background: loop the cover at the stream resolution, slow zoom.
    `[0:v]scale=${CFG.width * 1.2}:${CFG.height * 1.2}:force_original_aspect_ratio=increase,` +
      `crop=${CFG.width}:${CFG.height},` +
      `zoompan=z='min(zoom+0.0008,1.15)':d=1:s=${CFG.width}x${CFG.height}:fps=${CFG.fps}[bg]`,
    // QR code: scale to 220px square.
    `[1:v]scale=220:220[qr]`,
    // Layer QR onto background top-right with 32px margin.
    `[bg][qr]overlay=W-w-32:32[bgqr]`,
    // Brand wordmark bottom-left.
    `[bgqr]drawtext=text='${wordmark}':fontfile=${fontFile}:` +
      `fontsize=42:fontcolor=white:` +
      `box=1:boxcolor=black@0.35:boxborderw=10:` +
      `x=32:y=H-th-32[wm]`,
    // Now-playing strip bottom-center.
    `[wm]drawtext=text='${nowPlaying}':fontfile=${fontFile}:` +
      `fontsize=28:fontcolor=white:` +
      `box=1:boxcolor=black@0.55:boxborderw=14:` +
      `x=(w-text_w)/2:y=H-th-110[v]`,
  ].join(";");

  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-re", // read input at native rate so the stream doesn't sprint ahead
    "-loop", "1", "-i", coverPath, // [0] cover image
    "-i", qrPath,                  // [1] QR code
    "-i", audioUrl,                // [2] audio
    "-filter_complex", filter,
    "-map", "[v]", "-map", "2:a",
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
    // Stop encoding when the audio input ends — otherwise the looped
    // cover image would broadcast silence forever.
    "-shortest",
    "-f", "tee",
    teeDest,
  ];
}

// ─── main loop ───────────────────────────────────────────────────────────

let stopping = false;
let current = null; // child process

process.on("SIGTERM", () => { stopping = true; current?.kill("SIGTERM"); });
process.on("SIGINT",  () => { stopping = true; current?.kill("SIGINT");  });

async function streamTrack(track) {
  const id = track.id_key;
  const title = track.title ?? "Unknown";
  const artist = (track.vibe_description ?? "").split(" by ")[1]?.replace(".", "") ?? "Unknown";

  // Per-track deep link → `/t?to=/track/<id>` redirects with UTM.
  const deepLink = `${CFG.siteOrigin}/t?to=${encodeURIComponent(`/track/${encodeURIComponent(id)}`)}`;

  // Prepare overlay assets.
  const [coverPath, qrPath] = await Promise.all([
    fetchCover(track.image_url || track.coverSrc, id),
    makeQRPng(deepLink, id),
  ]);

  // Mirror current track to disk so the chat bot can read it.
  writeState({
    id, title, artist, deepLink,
    startedAt: Date.now(),
    audioUrl: track.audio_url,
  });

  console.log(`▶ ${title} — ${artist} (${id})`);

  return new Promise((resolve) => {
    const args = ffmpegArgsForTrack({
      audioUrl: track.audio_url,
      coverPath, qrPath, title, artist,
    });
    current = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    current.on("exit", (code, signal) => {
      current = null;
      if (signal) console.log(`  ↳ killed (${signal})`);
      else if (code === 0) console.log(`  ↳ done`);
      else console.log(`  ↳ exit ${code}`);
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
      console.error("catalog load failed, retrying in 30s:", err.message);
      await sleep(30_000);
      continue;
    }
    const blocklist = loadBlocklist();
    const queue = shuffle(catalog).filter((t) => !blocklist.has(t.id_key));
    if (queue.length === 0) {
      console.error("no playable tracks — sleeping 60s");
      await sleep(60_000);
      continue;
    }
    for (const track of queue) {
      if (stopping) break;
      try {
        await streamTrack(track);
      } catch (err) {
        console.error(`track failed: ${err.message} — skipping`);
        await sleep(2_000);
      }
    }
  }
  console.log("streamer stopped");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
