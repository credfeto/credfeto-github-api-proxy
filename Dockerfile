FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json esbuild.config.mjs ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Test stage — Docker build fails here if any test fails ──────────────────
FROM builder AS tester

RUN npm test


FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

WORKDIR /app

# Copy from tester (not builder directly) so tests must pass before the image is assembled
COPY --from=tester /app/dist/index.js ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
#  CMD ["/nodejs/bin/node", "-e", \
#    "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

# distroless runs as nonroot (uid 65532) by default
CMD ["index.js"]
