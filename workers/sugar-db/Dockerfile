FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY workers/sugar-db/package.json ./workers/sugar-db/
COPY iii-sdk/package.json ./iii-sdk/
RUN corepack enable && pnpm install --frozen-lockfile
CMD ["node", "--import", "tsx", "workers/sugar-db/src/index.ts"]
