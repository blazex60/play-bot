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
# imports it on Linux too. Install numpy explicitly after the torch wheel
# (which no longer pulls numpy in as a hard dependency).
#
# CUDA 12.6 build, pinned: the production GPU is a GTX 970 (Maxwell, sm_52)
# and 2.7.1+cu126 still ships sm_50 kernels (verified on the host
# 2026-11-26: full track in 27 s vs 410 s on 4 CPU threads). Newer CUDA
# builds are dropping Maxwell — re-check `torch.cuda.get_arch_list()`
# before bumping. The same wheel runs on CPU when no GPU is present
# (DEMUCS_DEVICE=auto falls back; src/audio/demucsDevice.js).
RUN python3 -m venv /opt/demucs-venv \
  && /opt/demucs-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/demucs-venv/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu126 torch==2.7.1 torchaudio==2.7.1 \
  && /opt/demucs-venv/bin/pip install --no-cache-dir numpy demucs \
  && /opt/demucs-venv/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

# Beat This! (CPJKU, MIT code and weights) for beats/downbeats on the GPU
# (src/audio/beatThis.js). --no-deps so it cannot replace the pinned
# cu126 torch above; its other runtime deps are listed explicitly. The
# final0 checkpoint (77 MB) is fetched at build time into TORCH_HOME.
RUN /opt/demucs-venv/bin/pip install --no-cache-dir --no-deps beat-this==1.1.0 rotary-embedding-torch==0.9.2 \
  && /opt/demucs-venv/bin/pip install --no-cache-dir einops soxr tqdm \
  && /opt/demucs-venv/bin/python -c "from beat_this.inference import load_model; load_model('final0', 'cpu')"

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
