# Astra Campaign Studio — sandbox image (spec §16.3 "co-development in a sandbox").
# Runs fully self-contained on embedded Postgres (PGlite); point DATABASE_URL at a
# real Postgres (see docker-compose.yml) for a shared/durable sandbox.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm install --no-save tsx \
  && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=4000 \
    ASTRA_PG_DIR=/data/pg

# Embedded-Postgres data lives on a volume so campaigns survive restarts.
VOLUME /data
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/experience/server.ts"]
