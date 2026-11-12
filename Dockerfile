FROM node:22-alpine

# Instala ffmpeg e ffprobe para leitura/gravação de metadados e capas
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000
ENV MUSIC_DIR=/media/music

VOLUME ["/media/music"]
EXPOSE 3000

CMD ["node", "server.js"]
