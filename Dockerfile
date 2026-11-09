# One process serves the marketing site and the Change Monitor app.
# Build from the repo root: docker build -t pricewatch .
FROM node:22-alpine
WORKDIR /srv
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --omit=dev --prefix server
COPY . .
WORKDIR /srv/server
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
