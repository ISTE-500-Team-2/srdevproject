# Reservation intervals and waiver fields — October 28, 2026

Follow-up on `codex/table-layout-audit`; earlier table changes are retained.

## PR #78 integration

Rebased onto `feat/password-reset` at `06f0894` with the shared table heading conflict resolved and the new typography tokens retained. The combined
code passes 248 frontend tests (40 files), all 35 frontend integration tests
(13 files), and the TypeScript/Vite production build. The integration suite
includes the existing password, equipment maintenance and studio workflows.
Backend source is unchanged by these fixes. Screenshots below were captured
before rebasing onto the newer PR code.

## Findings and changes

- The reservation picker used the next **minute** as its default, allowed arbitrary
  minute entry, and displayed half-hour values only as suggestions. It now uses a
  select containing only `:00` and `:30` starts. At 7:16 PM the default is 7:30 PM;
  a one-hour booking ends at 8:30 PM. Exactly at 7:30 PM the next future slot is
  8:00 PM. Late-night starts roll to tomorrow when necessary.
- An open picker refreshes every 30 seconds and advances a start that has become
  stale. Choosing another day preserves a valid selected time; returning to today
  advances a time that is already past. Dates beyond the quick choices remain
  available. Frontend submission validation also rejects off-grid minutes.
- The staff reservation editor uses a 1,800-second input step and the same local
  interval check. A regression test caught the generic request-error formatter
  hiding local validation messages; the editor now displays the actual message.
- Waiver identity, signing dates and administrative facts looked like editable
  fields despite being read-only. They now display as text labelled **Recorded
  automatically**, with visually distinct styling.
- Editable fields now have explicit required/optional labels, persistent hints
  linked with `aria-describedby`, examples, and 44 px controls with focus outlines.
  Birth date, account email, emergency contact details, typed signature and
  guardian details each have specific guidance. Signature fields remain blank
  and explain which name is required. Appropriate email/birth-date autocomplete
  is enabled; emergency contacts are not filled with the participant's details.
- Guardian inputs appear and become required only after opting into that section;
  toggling the section preserves drafts. Guardian email/phone labels identify whose
  details are needed. The agreement wording and server-side signature/record
  validation remain unchanged.
- Mobile review caught intrinsic grid and nonwrapping checkbox-label overflow.
  Form tracks now shrink and agreement labels wrap within the modal.

This is a booking-form change. The backend's general ISO timestamp parser remains
unchanged, and existing off-grid records are not migrated. Staff modifying an
off-grid reservation must choose a half-hour start.

## Verification

- **219 frontend tests passed across 37 files**, followed by a successful
  TypeScript/Vite production build: [log](frontend-check.log).
- **2 database-backed integration tests passed** using temporary test databases:
  booking creation, conflict/cooldown recovery and cancellation; and complete
  waiver entry, guardian fields, signature/contact error recovery, signing and
  retrieving the completed document: [log](integration-check.log).
- Regression coverage includes 7:16 PM, exact half-hour boundaries, hour/day
  rollover, stale defaults, selected dates/times, off-grid submission, staff
  validation, field guidance and guardian disclosure.
- Browser review on the Docker site verified the dropdown contains only future
  half-hour slots and its summary matches the selected start and duration.
  Waiver fields were reviewed on desktop and at 390 px. UI review did not submit
  a waiver acceptance in the user's demo session.
- Final Docker app build passed; `git diff --check` passed. Existing Vite bundle
  size advisory remains.

Screenshots: [waiver before](waiver-before.png), [waiver after](waiver-after.png),
[guardian fields](guardian-after.png), [mobile waiver](waiver-mobile-after.png),
[reservation picker](reservation-after.png).

## Try it locally

Open **http://localhost:8081** with **Member demo**. Under Equipment, select a
machine and check Start time and the booking summary. Under Certifications &
Waivers, review the specialized equipment agreement to inspect the field hints,
automatic details and optional guardian section.

```sh
docker compose -f compose.mvc.yml up -d --build
docker compose -f compose.mvc.yml ps
```
