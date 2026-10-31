FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends adb ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Pin the server jar to the version this code's control protocol implements
# (SCRCPY_SERVER_VERSION default in src/utils/constants.ts). No scrcpy client
# binary is needed at runtime: the session code speaks the protocol itself.
RUN mkdir -p /opt/scrcpy \
  && curl -fsSL -o /opt/scrcpy/scrcpy-server \
    https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4 \
  && echo "8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e  /opt/scrcpy/scrcpy-server" \
    | sha256sum -c -
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=8812 \
    MCP_HTTP_HOST=0.0.0.0 \
    SCRCPY_SERVER_PATH=/opt/scrcpy/scrcpy-server \
    SCRCPY_SERVER_VERSION=3.3.4
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8812
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||'8812')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
