FROM node:22-alpine AS web-build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY web/ ./web/
RUN node node_modules/vite/bin/vite.js build --config web/vite.config.js --outDir dist

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg python3 py3-pip build-base && \
    pip3 install --break-system-packages -U "yt-dlp[default]"

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY --from=web-build /app/web/dist ./web/dist

CMD ["npm", "start"]
