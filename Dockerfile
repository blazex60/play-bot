FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip3 install --break-system-packages yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

CMD ["node", "src/index.js"]
