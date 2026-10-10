# syntax=docker/dockerfile:1
# Qatar Mobile Trade-In — frontend (apps/web) for Railway. Build context: repository root.
# The page is built from the unchanged 3.1 sources with the API origin baked in (browser-safe values only).
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Railway passes service variables of the same name as build arguments.
ARG QM_API_BASE=https://api.qmtradein.com
ARG QM_STAFF_SIGN_IN=password
ARG QM_ENVIRONMENT_LABEL=PRODUCTION
COPY apps/web ./apps/web
RUN QM_TRANSPORT=railway QM_API_BASE="${QM_API_BASE%%,*}" QM_STAFF_SIGN_IN="$QM_STAFF_SIGN_IN" QM_ENVIRONMENT_LABEL="$QM_ENVIRONMENT_LABEL" node apps/web/build.mjs

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/web ./dist/web
COPY --chown=node:node apps/web/server.mjs ./apps/web/server.mjs
COPY --chown=node:node apps/web/icons ./apps/web/icons
COPY --chown=node:node apps/web/catalog ./apps/web/catalog
COPY --chown=node:node apps/web/templates ./apps/web/templates
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.mjs"]
