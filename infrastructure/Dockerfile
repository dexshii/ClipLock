# Multi-target image for the ClipLock server components.
#   docker build -f infrastructure/Dockerfile --target api    -t cliplock-api .
#   docker build -f infrastructure/Dockerfile --target worker -t cliplock-worker .
#   docker build -f infrastructure/Dockerfile --target web    -t cliplock-web .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @cliplock/shared --filter @cliplock/ui --filter @cliplock/api --filter @cliplock/worker --filter @cliplock/web
RUN pnpm --filter @cliplock/shared build \
 && pnpm --filter @cliplock/api build \
 && pnpm --filter @cliplock/worker build \
 && pnpm --filter @cliplock/web build
# Self-contained production trees for the Node services.
RUN pnpm deploy --legacy --filter @cliplock/api --prod /out/api \
 && pnpm deploy --legacy --filter @cliplock/worker --prod /out/worker

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/worker ./
USER node
CMD ["node", "dist/worker.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
