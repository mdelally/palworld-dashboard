# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY client ./client
COPY server ./server
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DASHBOARD_PORT=8787
# Parser sidecar (PlM/Oodle via MRHRTZ fork + pyooz)
ENV PALWORLD_PARSER_PYTHON=/opt/parser-venv/bin/python

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    build-essential \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY parser/requirements.txt /opt/parser/requirements.txt
RUN python3 -m venv /opt/parser-venv \
  && /opt/parser-venv/bin/pip install --no-cache-dir -U pip \
  && /opt/parser-venv/bin/pip install --no-cache-dir -r /opt/parser/requirements.txt \
  && apt-get purge -y --auto-remove build-essential git \
  && rm -rf /var/lib/apt/lists/* /root/.cache/pip

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY parser ./parser
COPY --from=build /app/client/dist ./client/dist

EXPOSE 8787
# Compose overrides to root for Unraid bind-mounts / docker.sock; image default stays non-root.
USER node
CMD ["node", "server/index.js"]
