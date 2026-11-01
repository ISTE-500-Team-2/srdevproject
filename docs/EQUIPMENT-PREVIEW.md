# Equipment and studio development preview

This preview runs the application, Vite development server and an isolated sample
PostgreSQL database in Docker. It does not use the production database.

From the repository root, with Docker Desktop running:

```sh
docker build --target dependencies -t arbor-equipment-dependencies .
docker compose -p arbor-equipment-preview -f compose.mvc.yml -f compose.preview.yml up -d --build
```

Open http://localhost:5173 and choose Member demo or Admin demo. Frontend source
changes refresh the browser automatically. Backend changes require rerunning the
Compose command with `--build`. Use port 5173 for browser testing; the backend's
allowed origin is configured for that address.

```sh
# Inspect containers
docker compose -p arbor-equipment-preview -f compose.mvc.yml -f compose.preview.yml ps
# Stop while retaining local demo data
docker compose -p arbor-equipment-preview -f compose.mvc.yml -f compose.preview.yml stop
```

The backend also listens on localhost:8081 and PostgreSQL on localhost:25432.
Keep Docker Desktop running. The preview uses its own named Docker volumes.

## Studio demo configuration

The initial demo contains eight active studios with prices: three small, three
medium and two large. Their cancellation policies start unconfirmed, so they are
hidden from the member catalog until an administrator configures their terms.
Configure them through the staff studio settings before testing rentals.

During this development session only, the existing local sample database was
configured with `full_before_start` cancellation policies and confirmed terms for
all eight studios. These were demo assumptions, not copied production policies.
This PR does not change production records or seed those policy assumptions into
fresh databases. The current Docker volume retains the local configuration.

## Max: configure local Stripe test checkout

The Stripe integration already exists. This preview has no Stripe credentials,
so the member dialog displays a disabled card option explaining the missing
configuration. No successful Stripe-hosted checkout has been verified locally.

1. Create `stripe.local.env` at the repository root using the appropriate Stripe
   test account. This filename is ignored by Git and excluded from Docker build
   context. Do not commit or share the credentials in chat.
2. Set `STRIPE_TEST_SECRET_KEY` and `STRIPE_STUDIO_WEBHOOK_SECRET` in that file.
   The existing backend accepts test keys only; do not use live credentials.
3. Configure test webhooks or Stripe CLI forwarding to
   `http://localhost:5173/api/webhooks/stripe-studios` (equivalently,
   `http://localhost:8081/api/webhooks/stripe-studios`). Use the signing secret for
   the actual local webhook forwarding session, not a different endpoint.
4. Restart the Compose preview to load the environment file. `APP_ORIGIN` is
   already `http://localhost:5173`, which is also the checkout return origin.
5. Verify the card option enables, checkout opens, a successful test payment
   confirms the correct rental, return-page reconciliation works, and signed
   callbacks are received. Verify unpaid/expired holds and refunds as well.

Supported webhook events and payment-state safeguards are documented in
[studio-rentals.md](studio-rentals.md#optional-stripe-test-setup).

Equipment retains immediate confirmation with no online payment. Adding equipment
payment holds is outside this change.
