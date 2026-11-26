FROM oven/bun:1 AS web-build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY web/ ./web/
RUN bun --bun node_modules/vite/bin/vite.js build --config web/vite.config.js --outDir dist

FROM node:22-bookworm-slim

WORKDIR /app

ENV TORCH_HOME=/opt/torch-cache
ENV DEMUCS_VENV=/opt/demucs-venv
ENV PATH="/opt/demucs-venv/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      aubio-tools \
      python3 \
      python3-pip \
      python3-venv \
      python3-dev \
      build-essential \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=web-build /usr/local/bin/bun /usr/local/bin/bun

# demucs 4.1.0 only declares numpy on Intel macOS, but transformer.py
# imports it on Linux too. Install numpy explicitly after the CPU torch
# wheel (which no longer pulls numpy in as a hard dependency).
RUN python3 -m venv /opt/demucs-venv \
  && /opt/demucs-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/demucs-venv/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu torch \
  && /opt/demucs-venv/bin/pip install --no-cache-dir numpy demucs \
  && /opt/demucs-venv/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

# Pinned so a version bump changes this line and busts the Docker layer
# cache. An unpinned `pip install -U` stayed cached across
# `docker compose up --build` deploys and kept running a months-old
# yt-dlp (2026.08.19 in Nov 2026 logs, with YouTube 403s). Installed after
# the demucs/torch layer so bumping it does not rebuild that one.
# Bump to the latest release on https://pypi.org/project/yt-dlp/ when
# YouTube extraction starts failing.
ARG YTDLP_VERSION=2026.11.23
RUN pip3 install --break-system-packages --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}"

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --omit=dev

COPY src/ ./src/
COPY --from=web-build /app/web/dist ./web/dist

CMD ["sh", "-c", "node src/discord/deploy.js --if-changed && node src/discord/main.js"]
