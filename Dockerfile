FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci --prefix backend && npm ci --prefix frontend
COPY backend ./backend
COPY frontend ./frontend
RUN npm run build --prefix backend && npm run build --prefix frontend

FROM build AS verify
COPY database ./database
COPY ddl ./ddl
CMD ["sh", "-c", "npm run check --prefix backend && npm run check --prefix frontend && npm run test:integration --prefix backend && npm run test:integration --prefix frontend"]

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev --prefix backend && npm cache clean --force
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY database ./database
COPY ddl/collaboratory-db-create.sql ./ddl/collaboratory-db-create.sql
RUN chmod -R a+rX /app/backend/dist /app/frontend/dist /app/database /app/ddl
RUN mkdir -p /app/.local && chown node:node /app/.local && chmod 700 /app/.local
USER node
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
