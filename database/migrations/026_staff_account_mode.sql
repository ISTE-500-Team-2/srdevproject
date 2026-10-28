-- Staff can open a member's account from the workspace and act on their behalf.
-- The open account lives on the sign-in family so access-token refreshes keep it;
-- audit rows still name the staff member through app.actor_id.
ALTER TABLE app_refresh_family
  ADD COLUMN acting_as_userid INTEGER REFERENCES "user"(userid) ON DELETE SET NULL;
