FROM node:16.14.0-alpine3.15 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

FROM node:16.14.0-alpine3.15
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
EXPOSE 8080
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
CMD ["node", "src/server.js"]