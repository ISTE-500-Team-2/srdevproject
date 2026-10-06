import type { Database } from "../db.js";

export interface AccountPreferences {
    notifications: {
        reservations: boolean;
        classes: boolean;
        membershipPayments: boolean;
    };
    accessibility: {
        largeText: boolean;
        highContrast: boolean;
        reducedMotion: boolean;
    };
}

export interface AccountPreferencesPatch {
    notifications?: Partial<AccountPreferences["notifications"]>;
    accessibility?: Partial<AccountPreferences["accessibility"]>;
}

export const defaultAccountPreferences: AccountPreferences = {
    notifications: {
        reservations: true,
        classes: true,
        membershipPayments: true,
    },
    accessibility: {
        largeText: false,
        highContrast: false,
        reducedMotion: false,
    },
};

export class PreferencesModel {
    constructor(private db: Database) { }

    async get(userId: number): Promise<AccountPreferences> {
        const { rows } = await this.db.query<{ preferences: AccountPreferences }>(
            `INSERT INTO account_preferences(userid) VALUES($1)
       ON CONFLICT(userid) DO UPDATE SET userid=EXCLUDED.userid
       RETURNING preferences`,
            [userId],
        );
        return rows[0]!.preferences;
    }

    async update(
        userId: number,
        preferences: AccountPreferencesPatch,
    ): Promise<AccountPreferences> {
        const patch = {
            notifications: {
                ...defaultAccountPreferences.notifications,
                ...preferences.notifications,
            },
            accessibility: {
                ...defaultAccountPreferences.accessibility,
                ...preferences.accessibility,
            },
        };
        const { rows } = await this.db.query<{ preferences: AccountPreferences }>(
            `INSERT INTO account_preferences(userid, preferences)
       VALUES($1, $2::jsonb)
       ON CONFLICT(userid) DO UPDATE
       SET preferences=jsonb_set(
         jsonb_set(account_preferences.preferences, '{notifications}',
           account_preferences.preferences->'notifications' || EXCLUDED.preferences->'notifications'),
         '{accessibility}',
         account_preferences.preferences->'accessibility' || EXCLUDED.preferences->'accessibility'),
           updated_at=NOW()
       RETURNING preferences`,
            [userId, JSON.stringify(patch)],
        );
        return rows[0]!.preferences;
    }
}
