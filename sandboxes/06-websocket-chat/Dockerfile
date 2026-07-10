# Pinned, well-known base image.
FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer caches across code edits.
COPY package.json ./
RUN npm install --omit=dev

# App code: the ws + redis chat server (it serves its own tiny HTML client).
COPY server.js ./

# 3000 = HTTP (serves the client) + the WebSocket upgrade, fronted by nginx.
EXPOSE 3000

CMD ["node", "server.js"]
