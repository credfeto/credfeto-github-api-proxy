FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json esbuild.config.mjs ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build


FROM node:20-alpine AS runtime

WORKDIR /app

# Only the single bundled file is needed — no node_modules
COPY --from=builder /app/dist/index.js ./

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "index.js"]
