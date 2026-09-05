# Collaboratory Frontend Prototype

A responsive React implementation of the six Team Arbor Figma mockups for The Collaboratory. The prototype uses local mock data so the team can review the flow before the API and database are connected.

## Run it

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The login screen includes two one-click demo roles:

- **Member demo** — member dashboard, reservations, certifications and waivers, classes, and profile settings
- **Admin demo** — member routes plus the analytics dashboard and user-management navigation

Any nonempty email and password also enters the member demo flow. Authentication, payments, booking, and profile changes are intentionally simulated in the browser.

## Prototype routes

- `/login` — login screen
- `/loading` — branded transition screen
- `/` — member dashboard
- `/admin` — admin analytics dashboard
- `/certifications` — certification and waiver records with training signup
- `/reservations` — equipment and studio reservations
- `/classes` — searchable class catalog
- `/profile` — interactive account settings

## Commands

```bash
npm run check   # TypeScript, tests, and production build
npm run test    # Vitest suite
npm run build   # Production bundle
```

## Design source

Implemented from the `Team Arbor - Mockups` Figma file and its exported six-page PDF. Images in `public/assets` were extracted from the team-owned mockup export; the layout, typography, palette, and paper texture are reproduced in responsive CSS.

## Backend handoff

The UI is deliberately separated from backend assumptions. Replace `src/data/mockData.ts` and the browser-only `AuthContext` with API clients when the Express service is ready. The planned production authentication boundary is a short-lived access token held in memory plus an HttpOnly refresh cookie.
