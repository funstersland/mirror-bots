FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/polybots.db
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
