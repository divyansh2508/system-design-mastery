# Pinned, well-known base image.
FROM node:20-alpine

WORKDIR /app

# Install deps first so this layer caches across code edits.
COPY package.json ./
RUN npm install --omit=dev

# App code: the tri-protocol server, the tiny gRPC client, and the shared proto.
COPY server.js client.js user.proto ./

# 3000 = REST + GraphQL (HTTP/1.1); 50051 = gRPC (HTTP/2).
EXPOSE 3000 50051

CMD ["node", "server.js"]
