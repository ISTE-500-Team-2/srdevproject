// Reads the configured billing price tiers (app_billing_price) for the staff pricing page; changes go
// through BillingPricing.

import type { Database } from "../db.js";

export class BillingPriceModel {
  constructor(private db: Database) {}

  /** Every tier, in tier order. */
  async list() {
    return (await this.db.query('SELECT * FROM app_billing_price ORDER BY tierid')).rows;
  }
}
