FROM node:22-slim
WORKDIR /app
# Build tools in case better-sqlite3 has to compile from source
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/polybots.db
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
