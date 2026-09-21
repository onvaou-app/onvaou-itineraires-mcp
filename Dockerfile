# Image du serveur MCP (stdio), utilisée par les annuaires qui le démarrent
# pour le tester (Glama). OVO_API_KEY est fournie à l'exécution.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js format.js ./
ENTRYPOINT ["node", "server.js"]
