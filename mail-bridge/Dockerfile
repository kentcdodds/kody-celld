# kody mail bridge: SMTP listener that forwards mail to Kody + HTTP /send that
# relays through your SMTP provider. Build context is this directory.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY lib.mjs server.mjs ./
ENV NODE_ENV=production \
    MAIL_BRIDGE_SMTP_PORT=25 \
    MAIL_BRIDGE_HTTP_PORT=8025
EXPOSE 25 8025
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.MAIL_BRIDGE_HTTP_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
