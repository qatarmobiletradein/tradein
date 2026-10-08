# syntax=docker/dockerfile:1
# Qatar Mobile Trade-In API — container image for Railway (staging first).
# Railway builds with this Dockerfile automatically when it is present.
# Pinned base image (tag + digest) = reproducible builds.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# ---- build: compile TypeScript, then drop dev dependencies ---------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY apps/api ./apps/api
COPY packages ./packages
COPY tools ./tools
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime: compiled JS + production dependencies only ----------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Migrations and the fictional seeds travel with the image so the SAME
# build can run `npm run migrate` / `npm run seed:staging` as a one-off.
# Only these two folders: nothing else under supabase/ (CLI state, .env) is copied.
COPY --chown=node:node supabase/migrations ./supabase/migrations
COPY --chown=node:node supabase/seed ./supabase/seed
USER node
# Railway sets PORT; 8080 is only the local default.
EXPOSE 8080
# Exec form: node is PID 1 and receives SIGTERM for the graceful shutdown.
CMD ["node", "dist/apps/api/src/server.js"]
