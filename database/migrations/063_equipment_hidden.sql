-- Administrators can hide a machine from members without removing it. A hidden machine stays in
-- the staff workspace with its bookings, outages and history; members don't see it in the
-- catalog, can't get a quote for it and can't book it. Bookings it already has are kept, and
-- staff can still book it for a member. Showing it again puts it back in the member catalog.
ALTER TABLE equipment ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT false;
