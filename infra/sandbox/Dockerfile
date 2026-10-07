FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY services ./services
COPY shared ./shared
COPY scripts ./scripts
COPY docs/api_document ./docs/api_document
RUN npm ci --omit=dev --ignore-scripts
CMD ["node", "scripts/sandbox-server.js"]
