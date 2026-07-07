FROM node:20-bullseye-slim

WORKDIR /app

# better-sqlite3 собирается из исходников — нужны build-инструменты.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
