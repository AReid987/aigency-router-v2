FROM node:22-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY iii-sdk/package.json ./iii-sdk/
COPY iii-engine/package.json ./iii-engine/
COPY iii-engine/src/ ./iii-engine/src/
RUN corepack enable && pnpm install --frozen-lockfile
CMD ["node", "--import", "tsx", "iii-engine/src/engine.ts"]
