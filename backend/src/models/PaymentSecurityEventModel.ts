// Records payment security events (app_payment_security_event). Fixed fields only: attacker bodies,
// signatures and credentials are never stored.

import type { Database } from "../db.js";

export class PaymentSecurityEventModel {
  constructor(private db: Database) {}

  async recordInvalidStripeSignature() {
    await this.db.query("INSERT INTO app_payment_security_event(kind) VALUES('stripe.invalid_signature')");
  }
}
