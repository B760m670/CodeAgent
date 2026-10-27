FROM node:22-bookworm-slim

# Tools the agent uses inside workspaces.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl python3 python3-pip python3-venv build-essential openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:3000/healthz || exit 1
CMD ["node", "server/index.js"]
