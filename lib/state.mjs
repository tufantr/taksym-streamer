// Tiny on-disk state shared between the stream encoder and the chat bot.
// They run as sibling processes on the same VPS, so a file is the simplest
// IPC mechanism — no sockets, no Redis, no Vercel round-trip.
//
// Writes are atomic via temp file + rename so the chat bot never reads a
// half-written JSON.

import fs from "node:fs";
import path from "node:path";

const STATE_PATH = process.env.STATE_PATH ?? "/tmp/taksym-stream-state.json";

export function writeState(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

export function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { STATE_PATH };
