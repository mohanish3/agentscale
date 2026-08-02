FROM node:22-alpine

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# One image runs both roles; the worker overrides the command.
USER node
EXPOSE 8000
CMD ["node", "src/index.js"]
