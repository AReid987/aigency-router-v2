FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY iii-sdk/package.json ./iii-sdk/
COPY workers/translator/package.json ./workers/translator/
COPY workers/translator/src/ ./workers/translator/src/
RUN corepack enable && pnpm install --frozen-lockfile
CMD ["node", "--import", "tsx", "workers/translator/src/index.ts"]
