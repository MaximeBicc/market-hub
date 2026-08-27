FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/vm-sync ./apps/vm-sync

# Le lockfile de production reste volontairement inchangé pendant la phase 1.
# Cette image est réservée à vm-staging.
RUN pnpm install --no-frozen-lockfile

ENV NODE_ENV=production
EXPOSE 8080

CMD ["pnpm", "--filter", "@hub/vm-sync", "start"]
