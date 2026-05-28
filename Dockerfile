# Taksym 24/7 streamer — minimal Ubuntu-based image with Node 22 + FFmpeg
# + the bundled fonts FFmpeg's drawtext needs.
#
# Build:   docker build -t taksym-streamer .
# Run:     docker run --env-file .env taksym-streamer

FROM node:22-bookworm-slim

# ffmpeg from Debian repo is current enough (6.x) for our use case.
# fonts-dejavu provides the DejaVu Sans Bold font referenced by drawtext.
# ca-certificates so https fetches work.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       fonts-dejavu \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY lib/ ./lib/
COPY stream.mjs chat-bot.mjs ./

# Default to running the stream encoder. docker-compose overrides this
# for the chat-bot service.
CMD ["node", "stream.mjs"]
