FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://pkg.phase.dev/install.sh -o /tmp/install-phase.sh \
    && sh /tmp/install-phase.sh --version 2.3.2 \
    && rm /tmp/install-phase.sh
COPY --chmod=755 deploy/phase.sh /usr/local/bin/gains-phase
ENV PHASE_APP=gains PHASE_ENV=production HOME=/tmp
ENTRYPOINT ["gains-phase"]

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run typecheck

FROM build AS migrate
USER node
CMD ["migrate"]

FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS app
COPY --from=build /app/.output ./.output
COPY --from=production-deps /app/node_modules ./node_modules
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["start"]
