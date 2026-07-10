FROM node:20-bullseye-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json .npmrc ./
RUN npm install --omit=dev --no-audit --no-fund --prefer-online

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node scripts/healthcheck.js

CMD ["node", "src/index.js"]
