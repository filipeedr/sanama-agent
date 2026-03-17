# Stage 1: install dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: production runner
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/tessdata ./tessdata
# tesseract.js e todas as suas dependências diretas
COPY --from=builder /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=builder /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core
COPY --from=builder /app/node_modules/bmp-js ./node_modules/bmp-js
COPY --from=builder /app/node_modules/idb-keyval ./node_modules/idb-keyval
COPY --from=builder /app/node_modules/is-url ./node_modules/is-url
COPY --from=builder /app/node_modules/node-fetch ./node_modules/node-fetch
COPY --from=builder /app/node_modules/regenerator-runtime ./node_modules/regenerator-runtime
COPY --from=builder /app/node_modules/wasm-feature-detect ./node_modules/wasm-feature-detect
COPY --from=builder /app/node_modules/zlibjs ./node_modules/zlibjs

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
