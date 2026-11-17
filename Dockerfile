# agentes.chat image: API, WebSocket, workers and the web app in one Bun process.
# Self-hosting runs it with docker-compose.yml; agentes.chat Cloud runs the same image.
#
# The release is built by the same recipe as the native packages (`scripts/native-package.ts image`): the
# web app and the runner, the server bundled from main.ts with the packages that load WebAssembly of their
# own left beside it, the migrations and assets, and every license. Only that goes in the final image.
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && bun scripts/native-package.ts image --out /build

FROM oven/bun:1.4.4-alpine
WORKDIR /app
# A named volume mounted on an empty image directory takes its owner: FILES_DIR in docker-compose.yml.
RUN install -d -o bun -g bun /data/files
COPY --from=build /build/image/LICENSE /build/image/NOTICE ./
COPY --from=build /build/image/licenses ./licenses
COPY --from=build /build/image/server ./apps/server
COPY --from=build /build/image/web ./apps/web/dist
# The root filesystem can be read-only: the server writes only to /tmp and FILES_DIR, and the
# base image already turns off Bun's transpiler cache (BUN_RUNTIME_TRANSPILER_CACHE_PATH=0).
ENV NODE_ENV=production \
    WEB_DIR=/app/apps/web/dist \
    PORT=3000
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# ENTRYPOINT, not CMD, so `docker compose run --rm agentes migrate` reaches main.ts as argv. An
# absolute path: `docker run -w /work … setup` runs it from the directory being set up.
ENTRYPOINT ["bun", "/app/apps/server/lib/main.js"]
