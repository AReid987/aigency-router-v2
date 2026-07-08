FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY iii-sdk/package.json ./iii-sdk/
COPY workers/vault/package.json ./workers/vault/
COPY workers/vault/src/ ./workers/vault/src/
RUN corepack enable && pnpm install --frozen-lockfile
CMD ["node", "--import", "tsx", "workers/vault/src/index.ts"]
