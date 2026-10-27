FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS dependencies
WORKDIR /app
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci --prefix backend && npm ci --prefix frontend

# Keep source/build cache keys separate: editing a page must not recompile the
# unchanged backend. This also works on the production host's legacy builder.
FROM dependencies AS backend-build
COPY backend ./backend
RUN npm run build --prefix backend

FROM dependencies AS frontend-build
COPY frontend ./frontend
RUN npm run build --prefix frontend

# The verification target still runs the complete source-based suite. Runtime
# images use only the compiled output from the two independent build stages.
FROM dependencies AS verify
COPY backend ./backend
COPY frontend ./frontend
COPY database ./database
COPY ddl ./ddl
CMD ["sh", "-c", "npm run check --prefix backend && npm run check --prefix frontend && npm run test:integration --prefix backend && npm run test:integration --prefix frontend"]

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev --prefix backend && npm cache clean --force
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
COPY database ./database
COPY ddl/collaboratory-db-create.sql ./ddl/collaboratory-db-create.sql
RUN chmod -R a+rX /app/backend/dist /app/frontend/dist /app/database /app/ddl
RUN mkdir -p /app/.local && chown node:node /app/.local && chmod 700 /app/.local
USER node
EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
