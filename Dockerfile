FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 py3-pip build-base && \
    pip3 install --break-system-packages -U "yt-dlp[default]"

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

CMD ["node", "src/index.js"]
