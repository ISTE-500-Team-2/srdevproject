# Local minor workflow testing

Client clarification: minors may have their own accounts and separate equipment
and studio bookings. Their sponsoring adult must be linked and checked into the
same building during the visit. The adult does not have to stay beside the minor.
Adult checkout ends the minor's visit. Minors sign the same applicable policies
as adults; final legal wording remains pending.

Supervisors need facility policy signatures; operating equipment still requires
the operator's applicable equipment waivers and certifications. Advance class
enrollment records the linked active adult without requiring an open visit at
signup. Facility arrival continues to enforce adult presence.

## Manual acceptance sequence

Use separate browser profiles or sign out between accounts. In the isolated local
demo, start with both people checked out and a linked minor/adult pair, each with
a current membership or pass.

1. Sign in as the minor. Confirm the Under 18 badge and sponsoring adult appear.
2. Complete the minor's facility policies through the normal waiver form. Confirm
   facility check-in and new equipment/studio bookings are denied while the adult
   is checked out.
3. As an administrator, open the adult's member record and use Visit & supervision
   to check the adult into the building. Then check in the minor.
4. As the minor, create an equipment booking independently of the adult's bookings.
   Equipment certification, equipment waivers, availability and payment rules
   still apply. Confirm the saved booking is linked to the adult.
5. Repeat with a configured studio. A new rental requires adult presence; reopening
   an existing rental after adult checkout must not create another rental.
6. Check out the adult. Confirm the minor is also checked out, new bookings are
   denied, and subsequent access checks fail. Existing bookings remain recorded.
7. With the adult checked out, enroll the minor in a future class. Confirm the
   active sponsor link is recorded; an absent or suspended sponsor link is denied.

## Automated verification

Run the backend TypeScript build and these PostgreSQL integration suites against
an explicitly isolated local database host:

```sh
npm run build --prefix backend
cd backend
npx tsx --test test/integration/minor-supervision.test.ts test/integration/day-pass-policies.test.ts test/integration/mvp-catalog.test.ts
```

On November 11, 2026, all 33 tests passed using Node 24 and PostgreSQL 16 in Docker.
The suites include checkout races, sponsor consent/link changes, studio replay,
same-building presence, equipment waiver enforcement and class enrollment. This
does not establish physical reader acceptance or production deployment.
