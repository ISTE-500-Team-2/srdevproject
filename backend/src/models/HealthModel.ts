// The health check's database probe: one trivial round trip proves a connection can be had.

import type { Database } from "../db.js";

export class HealthModel {
  constructor(private db: Database) {}

  /** Rejects when the database can't be reached. */
  async ping() {
    await this.db.query("SELECT 1");
  }
}
