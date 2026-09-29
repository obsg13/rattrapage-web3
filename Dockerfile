FROM node:22.23.3-alpine3.24 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

FROM node:22.23.3-alpine3.24
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
EXPOSE 8080
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
CMD ["node", "src/server.js"]