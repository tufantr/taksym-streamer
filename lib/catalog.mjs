// Fetch the Taksym catalog from the live Vercel API. The streamer is
// decoupled from the Next.js repo — it talks to taksym.com like any other
// API consumer. Cached in-memory for the life of the process.

const CATALOG_URL = process.env.CATALOG_URL ?? "https://www.taksym.com/api/songs";

let cached = null;
let lastFetch = 0;
const TTL_MS = 15 * 60 * 1000; // re-fetch every 15 minutes so new tracks land

export async function loadCatalog() {
  const now = Date.now();
  if (cached && now - lastFetch < TTL_MS) return cached;
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const songs = await res.json();
  // Defensive: only keep tracks with playable audio.
  cached = songs.filter((s) => s.audio_url && s.id_key);
  lastFetch = now;
  return cached;
}

// Fisher–Yates shuffle. Returns a new array.
export function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
