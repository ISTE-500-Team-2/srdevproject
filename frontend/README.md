# Collaboratory React views

React views now use the Express/PostgreSQL API for authentication, equipment reservations, account activity, waivers, certifications and profile updates. The class catalog and admin analytics remain clearly labeled previews.

See [the MVC guide](../docs/MVC.md) for full setup, current scope, API contracts and tests. Start the API on port 8080, then `npm ci && npm run dev` here; Vite proxies `/api`. Production builds are served by Express from the same origin.

The UI originated from the six-page Team Arbor Figma mockup export. Figma MCP is not connected; this implementation does not claim live design synchronization.

Commands: `npm run check` runs unit tests, TypeScript and the build. `npm run test:integration` drives the React-to-PostgreSQL flow against an explicitly configured isolated test server; see the root guide.
