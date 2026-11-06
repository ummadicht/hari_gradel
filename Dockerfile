# Stage 1: Build
FROM node:24-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN node -e 'const fs=require("fs"),f="node_modules/next/dist/compiled/@next/font/dist/google/loader.js";if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(".exec(googleFontFileUrl)[1]",".exec(googleFontFileUrl)?.[1]||\"woff2\""))'

COPY . .
ARG NEXT_PUBLIC_BASE_PATH="/apps/gradeiq"
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

RUN npm run check:authz && npm run build
RUN npm prune --omit=dev

# Stage 2: Production Runner with PM2
FROM node:24-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    npm install -g pm2 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3800
ENV NEXT_PUBLIC_BASE_PATH="/apps/gradeiq"

RUN mkdir -p /app/data

COPY --from=builder /app/package.json /app/package-lock.json /app/next.config.ts /app/middleware.ts ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next

COPY --from=builder /app/scripts/migrate-sqlite-to-postgres.mjs ./scripts/migrate-sqlite-to-postgres.mjs
COPY --from=builder /app/schema.postgres.sql ./schema.postgres.sql

EXPOSE 3800
CMD ["pm2-runtime", "start", "npm", "--name", "gradeiq", "--", "start"]
