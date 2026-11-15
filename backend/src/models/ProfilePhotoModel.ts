// Stores each person's one profile photo (app_user_photo). Validation happens before this layer;
// see profilePhoto.ts.

import type { Database } from "../db.js";
import type { ProfilePhoto, ProfilePhotoType } from "../profilePhoto.js";

export class ProfilePhotoModel {
  constructor(private db: Database) {}

  async find(userId: number): Promise<ProfilePhoto | null> {
    const { rows } = await this.db.query<{ contentType: ProfilePhotoType; image: Buffer; version: string }>(
      `SELECT content_type AS "contentType", image, version FROM app_user_photo WHERE user_id=$1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /**
   * The current version (null without a photo). Locks the account row, which exists even before a
   * first photo, so concurrent changes to one person's photo run one after another. The version is
   * read by a second statement: under READ COMMITTED it then sees what a change that held the lock
   * committed, where a single locking query would answer from its snapshot taken before the wait.
   */
  async lockVersion(userId: number): Promise<string | null> {
    await this.db.query('SELECT 1 FROM "user" WHERE userid=$1 FOR NO KEY UPDATE', [userId]);
    const { rows } = await this.db.query<{ version: string }>(
      "SELECT version FROM app_user_photo WHERE user_id=$1",
      [userId],
    );
    return rows[0]?.version ?? null;
  }

  async save(userId: number, photo: ProfilePhoto): Promise<void> {
    await this.db.query(
      `INSERT INTO app_user_photo(user_id,content_type,image,version) VALUES($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET content_type=EXCLUDED.content_type, image=EXCLUDED.image,
         version=EXCLUDED.version, updated_at=now()`,
      [userId, photo.contentType, photo.image, photo.version],
    );
  }

  async remove(userId: number): Promise<boolean> {
    const result = await this.db.query("DELETE FROM app_user_photo WHERE user_id=$1", [userId]);
    return (result.rowCount ?? 0) > 0;
  }
}
