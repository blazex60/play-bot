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

RUN pip3 install --break-system-packages -U "yt-dlp[default]"

RUN python3 -m venv /opt/demucs-venv \
  && /opt/demucs-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/demucs-venv/bin/pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu torch \
  && /opt/demucs-venv/bin/pip install --no-cache-dir demucs \
  && /opt/demucs-venv/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY --from=web-build /app/web/dist ./web/dist

CMD ["sh", "-c", "node src/deploy.js --if-changed && node src/index.js"]
