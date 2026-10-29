# Table layout audit — October 28, 2026

Base: `851623e` (latest `origin/main` pulled before review). Work branch:
`codex/table-layout-audit`. Review uses the isolated Docker demo at localhost:8081.

These fixes were subsequently rebased onto PR #78 (`feat/password-reset`,
`06f0894`). Combined validation: 248 frontend tests, 35 frontend integration
tests and the production build passed. The PR replaces the old occupancy calendar;
calendar findings and screenshots below describe the original audit baseline.

## Findings and work log

1. Reports render tables as blocks, so short tables do not fill their available
   width. All headers are forced onto one line; the notification report is over
   1,500 px wide at the default desktop viewport. Move scrolling to a named,
   keyboard-focusable wrapper and preserve native full-width table layout.
2. Report and analytics counts, money and percentages are left-aligned. Align
   numeric headers and values to the right with tabular digits.
3. Generic management cell selectors override the directory's intended 12 × 16 px
   cell padding. Scope presentation to data tables and share consistent spacing.
4. Member history has no scrolling boundary. Keep wide records inside a named
   scroll region so small screens retain readable dates and statuses.
5. Member credential headers are oversized (up to 21.6 px), with inconsistent
   wrapping between the two panels. Long waiver names crowd status/date columns.
   Use shared compact headings and readable column widths; allow names to wrap.
6. The same generic management selector also overrides the studio occupancy
   calendar's centered cells and compact padding. Removing it restores native
   table layout, centered day cells and 4 px calendar padding.
7. A first mobile pass exposed intrinsic grid sizing in member history. Allow
   direct management grid children to shrink so the scroll wrapper stays inside
   its panel. Balance the two credential panels and keep their headings on one
   line so all three columns fit at 1280 px.

Baseline screenshots: [reports](reports-before.png),
[member credentials](credentials-before.png).

## Validation

- Frontend checks in the Docker verification image: **36 test files, 213 tests
  passed**, followed by a successful TypeScript/Vite production build. See
  [frontend-check.log](frontend-check.log). Subsequent changes were CSS, layout
  classes and indentation; the final Docker application build also passed.
- Browser checks used the actual Admin demo and Member demo accounts. Reviewed
  staff directory, reports, expanded analytics tables, studio occupancy, member
  credential/waiver tables, expanded membership history and payment empty state.
- At 390 px, report scroll regions remain 343 px wide; the widest report is
  contained within its region. Directory cells use the intended 12 × 16 px
  padding. Membership history is 293 px wide with its 512 px table scrollable
  inside. Document width remains within the viewport.
- Member history and credentials also checked at 320 px without page overflow.
- At 1280 px, both credential panels show all three columns without horizontal
  scrolling. The calendar retains `display: table`, centered day cells and 4 px
  padding. Analytics numeric values are right-aligned.
- Keyboard ArrowRight exercised on report/history scroll regions; visible focus
  outlines retained. Native column and row header scopes retained or added.
- `git diff --check` passed.
- Existing build warning: some JavaScript chunks exceed Vite's size advisory.
  This audit does not change dependencies or bundle loading.

After screenshots: [desktop credentials](credentials-after.png),
[phone credentials](credentials-mobile-after.png),
[phone history](membership-mobile-after.png),
[phone directory](directory-mobile-after.png), [reports](reports-after.png),
[phone reports](reports-mobile-after.png), [analytics](analytics-after.png),
[studio calendar](studio-calendar-after.png).

The demo has no payment records or scheduled classes; populated payment history
and class schedule actions were not visually exercised. Their existing tests
passed. Other staff sections use cards/lists, rather than native data tables.

An unrelated reporting-data anomaly was observed: equipment with zero bookings
shows 24 booked hours / 100% utilization in this demo. This is recorded for a
separate reporting-logic investigation; this change concerns layout only.

## Local testing

Open **http://localhost:8081/login** and select **Admin demo** or **Member demo**.
The Docker app and PostgreSQL database use `compose.mvc.yml`, bound to localhost.

```sh
docker compose -f compose.mvc.yml up -d --build
docker compose -f compose.mvc.yml ps
docker compose -f compose.mvc.yml stop
```

To compare, open Admin → Members, Analytics → Show as table, Reports, and Studios;
then Member → Certifications & Waivers and Membership → History. Narrow the
browser to a phone width and tab into a table region to scroll with arrow keys.
