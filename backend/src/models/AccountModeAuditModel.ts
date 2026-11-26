// Staff audit entries for opening and leaving a member's account (account mode). Callers pass the
// transaction that changes the sign-in, so the entry commits with it.

import type { Database } from "../db.js";

export class AccountModeAuditModel {
  constructor(private db: Database) {}

  async opened(actorId: number, subjectId: number) {
    await this.db.query(
      `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason) VALUES($1,$2,'account_mode.opened','user',$2,'Opened from the staff workspace')`,
      [actorId, subjectId],
    );
  }

  async closed(actorId: number, subjectId: number) {
    await this.db.query(
      `INSERT INTO app_staff_audit(actor_id,subject_id,action,entity_type,entity_id,reason) VALUES($1,$2,'account_mode.closed','user',$2,'Returned to the staff workspace')`,
      [actorId, subjectId],
    );
  }
}
