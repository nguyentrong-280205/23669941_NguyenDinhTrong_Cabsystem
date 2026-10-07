FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY services ./services
COPY shared ./shared
COPY docs/api_document ./docs/api_document
RUN npm ci --omit=dev --ignore-scripts
ENV SERVICE_NAME=notification
USER node
CMD ["node", "services/notification/src/server.js"]
