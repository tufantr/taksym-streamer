#!/usr/bin/env node
//
// Multi-platform chat bot for the Taksym 24/7 stream.
//
//   • Twitch — IRC via tmi.js, OAuth-style token
//   • Kick   — undocumented WebSocket chat (Pusher protocol)
//   • YouTube — Live Chat API via OAuth2 refresh token (one-time consent)
//
// Commands (work on any platform):
//   !song   → current track + per-track deep link with UTM tag
//   !mix <prompt>  → generates a fresh public Mood Mix on the live site
//                    and posts the share URL back to chat
//   !today  → link to /today
//   !link   → bare URL
//
// Plus a periodic auto-post every CHAT_AUTOPOST_INTERVAL_MIN minutes that
// drops the brand URL into all connected chats — keeps the channel feeling
// alive when no humans are speaking.

import tmi from "tmi.js";
import WebSocket from "ws";
import { google } from "googleapis";

import { readState } from "./lib/state.mjs";

const CFG = {
  // Twitch
  twitchChannel: (process.env.TWITCH_CHANNEL ?? "taksymofficial").toLowerCase(),
  twitchBotUser: process.env.TWITCH_BOT_USER ?? "taksymofficial",
  twitchOauth: process.env.TWITCH_CHAT_OAUTH ?? "", // "oauth:..." token

  // Kick
  kickChannelSlug: process.env.KICK_CHANNEL_SLUG ?? "taksymofficial",
  // Kick chat read is anonymous (Pusher-style); writing requires a
  // session token (KICK_CHAT_TOKEN) plus channel id. Both come from
  // Kick's "Stream URL & Key" + a quick devtools peek at the chat XHR.
  kickChannelId: process.env.KICK_CHANNEL_ID ?? "",
  kickChatToken: process.env.KICK_CHAT_TOKEN ?? "",

  // YouTube
  ytClientId: process.env.YOUTUBE_OAUTH_CLIENT_ID ?? "",
  ytClientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET ?? "",
  ytRefreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN ?? "",

  // Common
  siteOrigin: process.env.SITE_ORIGIN ?? "https://www.taksym.com",
  autopostMin: Number(process.env.CHAT_AUTOPOST_INTERVAL_MIN ?? 10),
  mixApiUrl: process.env.MIX_API_URL ?? "https://www.taksym.com/api/mood-mix",
};

// Per-platform UTM redirects keep attribution clean.
function brandLink(platform) {
  const code = { twitch: "t", youtube: "y", kick: "k" }[platform];
  return `${CFG.siteOrigin}/${code}`;
}

function deepLink(platform, path) {
  const code = { twitch: "t", youtube: "y", kick: "k" }[platform];
  return `${CFG.siteOrigin}/${code}?to=${encodeURIComponent(path)}`;
}

// ─── command handlers ───────────────────────────────────────────────────

// Returns the reply string for a given !command, or null to ignore.
async function handleCommand(platform, user, raw) {
  const text = raw.trim();
  if (!text.startsWith("!")) return null;
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ");

  switch (cmd.toLowerCase()) {
    case "!link":
    case "!taksym":
      return `🎵 ${brandLink(platform)}`;

    case "!today":
      return `📅 Today's mix → ${deepLink(platform, "/today")}`;

    case "!song":
    case "!nowplaying":
    case "!np": {
      const s = readState();
      if (!s?.title) return `Couldn't read the current track right now — try again in a sec.`;
      return `▶ ${s.title} — ${s.artist} · ${deepLink(platform, `/track/${encodeURIComponent(s.id)}`)}`;
    }

    case "!mix": {
      if (!args) {
        return `Try: !mix late-night synthwave for coding`;
      }
      try {
        const res = await fetch(CFG.mixApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: args, size: 12 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return `Mix failed: ${data.error ?? `HTTP ${res.status}`}`;
        }
        // The /api/mood-mix endpoint returns trackIds but not a public
        // permalink — the share-able /mix/<id> URL is created only when
        // a signed-in user clicks Share in the modal. For a chat reply,
        // we surface the prompt + a "Generate this on Taksym" deep link
        // that pre-fills the modal via ?seed=<prompt>.
        const seeded = `${CFG.siteOrigin}/?seed=${encodeURIComponent(args)}&utm_source=${platform}&utm_medium=stream`;
        return `Mix queued for "${args}" · open on Taksym to play & save → ${seeded}`;
      } catch (err) {
        return `Mix failed: ${String(err.message || err).slice(0, 100)}`;
      }
    }

    default:
      return null;
  }
}

// ─── Twitch ─────────────────────────────────────────────────────────────

let twitchClient = null;

function startTwitch() {
  if (!CFG.twitchOauth) {
    console.log("twitch: TWITCH_CHAT_OAUTH not set, skipping");
    return;
  }
  twitchClient = new tmi.Client({
    options: { debug: false, skipUpdatingEmotesets: true },
    identity: { username: CFG.twitchBotUser, password: CFG.twitchOauth },
    channels: [CFG.twitchChannel],
    connection: { reconnect: true, secure: true },
  });
  twitchClient.on("message", async (channel, tags, msg, self) => {
    if (self) return;
    const reply = await handleCommand("twitch", tags["display-name"] || tags.username, msg);
    if (reply) twitchClient.say(channel, reply);
  });
  twitchClient.on("connected", () => console.log(`twitch: connected as ${CFG.twitchBotUser} in #${CFG.twitchChannel}`));
  twitchClient.connect().catch((err) => console.error("twitch connect failed:", err.message));
}

function twitchPost(text) {
  if (twitchClient?.readyState() === "OPEN") {
    twitchClient.say(`#${CFG.twitchChannel}`, text).catch(() => {});
  }
}

// ─── Kick ────────────────────────────────────────────────────────────────

let kickWs = null;
let kickReady = false;

function startKick() {
  if (!CFG.kickChannelId) {
    console.log("kick: KICK_CHANNEL_ID not set, skipping");
    return;
  }
  // Kick chat is on Pusher with a public app key. We subscribe to the
  // chatrooms.{id}.v2 channel as a read-only listener; writes go through
  // the Kick HTTP API.
  const url = "wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=8.4.0-rc2&flash=false";
  kickWs = new WebSocket(url);
  kickWs.on("open", () => {
    kickWs.send(JSON.stringify({
      event: "pusher:subscribe",
      data: { auth: "", channel: `chatrooms.${CFG.kickChannelId}.v2` },
    }));
    kickReady = true;
    console.log(`kick: connected to chatroom ${CFG.kickChannelId}`);
  });
  kickWs.on("message", async (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.event !== "App\\Events\\ChatMessageEvent") return;
    let payload;
    try { payload = JSON.parse(evt.data); } catch { return; }
    const text = payload?.content ?? "";
    const user = payload?.sender?.username ?? "anon";
    const reply = await handleCommand("kick", user, text);
    if (reply) kickPost(reply);
  });
  kickWs.on("close", () => {
    kickReady = false;
    console.log("kick: disconnected, reconnecting in 10s");
    setTimeout(startKick, 10_000);
  });
  kickWs.on("error", (err) => console.error("kick ws error:", err.message));
}

async function kickPost(text) {
  if (!CFG.kickChatToken || !CFG.kickChannelId) return;
  try {
    await fetch(`https://kick.com/api/v2/messages/send/${CFG.kickChannelId}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CFG.kickChatToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text, type: "message" }),
    });
  } catch (err) {
    console.error("kick post failed:", err.message);
  }
}

// ─── YouTube ─────────────────────────────────────────────────────────────

let ytAuth = null;
let ytYoutube = null;
let ytLiveChatId = null;
let ytNextPageToken = null;

async function startYouTube() {
  if (!CFG.ytClientId || !CFG.ytClientSecret || !CFG.ytRefreshToken) {
    console.log("youtube: oauth env vars not set, skipping");
    return;
  }
  ytAuth = new google.auth.OAuth2(CFG.ytClientId, CFG.ytClientSecret);
  ytAuth.setCredentials({ refresh_token: CFG.ytRefreshToken });
  ytYoutube = google.youtube({ version: "v3", auth: ytAuth });

  // Find the current live broadcast for the authenticated channel and
  // grab its liveChatId. We re-resolve this each time the stream restarts
  // (broadcast id is per-session).
  async function refreshLiveChatId() {
    try {
      const res = await ytYoutube.liveBroadcasts.list({
        part: ["snippet"],
        broadcastStatus: "active",
        broadcastType: "all",
      });
      const b = res.data.items?.[0];
      ytLiveChatId = b?.snippet?.liveChatId ?? null;
      if (ytLiveChatId) console.log(`youtube: liveChatId resolved`);
      else console.log("youtube: no active broadcast — will retry");
    } catch (err) {
      console.error("youtube: liveBroadcasts.list failed:", err.message);
    }
  }
  await refreshLiveChatId();
  // Re-resolve every 5 min in case the broadcast rolls over.
  setInterval(refreshLiveChatId, 5 * 60 * 1000);

  // Poll for new chat messages.
  async function pollChat() {
    if (!ytLiveChatId) return;
    try {
      const res = await ytYoutube.liveChatMessages.list({
        liveChatId: ytLiveChatId,
        part: ["snippet", "authorDetails"],
        pageToken: ytNextPageToken ?? undefined,
      });
      ytNextPageToken = res.data.nextPageToken ?? null;
      const items = res.data.items ?? [];
      for (const m of items) {
        const user = m.authorDetails?.displayName ?? "anon";
        const text = m.snippet?.displayMessage ?? "";
        // Skip our own bot's messages.
        if (m.authorDetails?.isChatOwner === true) continue;
        const reply = await handleCommand("youtube", user, text);
        if (reply) youtubePost(reply);
      }
    } catch (err) {
      // Quota errors are common on free tier — back off.
      console.error("youtube pollChat failed:", err.message);
    }
    setTimeout(pollChat, 10_000); // poll every 10s
  }
  pollChat();
}

async function youtubePost(text) {
  if (!ytYoutube || !ytLiveChatId) return;
  try {
    await ytYoutube.liveChatMessages.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          liveChatId: ytLiveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: text.slice(0, 200) },
        },
      },
    });
  } catch (err) {
    console.error("youtube post failed:", err.message);
  }
}

// ─── periodic autopost ─────────────────────────────────────────────────

function startAutopost() {
  if (CFG.autopostMin <= 0) return;
  const lines = [
    `🎵 Every track here is AI-generated — listen free on Taksym.`,
    `Try !mix <vibe> to spawn your own playlist.`,
    `!song to grab a link to the current track. !today for today's mix.`,
    `Bookmark ${CFG.siteOrigin}/today for a fresh mix every day.`,
  ];
  let i = 0;
  setInterval(() => {
    const line = lines[i % lines.length];
    i++;
    twitchPost(line);
    kickPost(line);
    youtubePost(line);
  }, CFG.autopostMin * 60 * 1000);
}

// ─── go ──────────────────────────────────────────────────────────────────

console.log(`chat-bot up · autopost every ${CFG.autopostMin}min`);
startTwitch();
startKick();
startYouTube();
startAutopost();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
