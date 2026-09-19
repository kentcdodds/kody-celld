# syntax=docker/dockerfile:1.7
# kody-celld runtime image: celld (from the official release image) + Node/esbuild
# (celld deploy bundles Workers with esbuild) + this project. One image serves
# every mode of docker/entrypoint.sh:
#   single  — one node with local durable state (NAS / laptop / single VPS)
#   deploy  — bundle and publish the Worker to the fleet bucket (one-shot job)
#   node    — a fleet node that serves the bucket's current deployment
ARG CELLD_VERSION=0.5.0
ARG NODE_VERSION=22

FROM ghcr.io/denoland/celld:${CELLD_VERSION} AS celld

FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY . .
# Browser bundle (Vite, remix/ui hydration) into public/build; celld serves
# public/ as static assets next to the Worker.
RUN npm run build:client \
  && chmod +x docker/entrypoint.sh docker/healthcheck.sh && mkdir -p /data /var/lib/celld

ENV PATH=/app/node_modules/.bin:$PATH \
    NODE_ENV=production \
    KODY_STATE_DIR=/data \
    CELLD_WATCH=/var/lib/celld \
    PORT=8080

EXPOSE 8080 9000
VOLUME ["/data", "/var/lib/celld"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["docker/healthcheck.sh"]

ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["single"]
