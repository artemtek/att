FROM node:22-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/src ./src
COPY db/migrations ./migrations
EXPOSE 3000
CMD ["node", "src/index.js"]
