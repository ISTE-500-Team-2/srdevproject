-- Separate facility agreements from waivers needed only for restricted equipment.
-- Existing policies keep their facility requirement unless explicitly classified.
ALTER TABLE waiver ADD COLUMN policy_scope TEXT NOT NULL DEFAULT 'facility'
  CHECK (policy_scope IN ('facility', 'equipment'));

-- This supplied agreement covers specialized equipment, rather than buying access.
-- Keep its text, versions, signatures and publication status intact.
UPDATE waiver SET policy_scope='equipment'
WHERE name LIKE 'Specialized Equipment Use%'
  AND name LIKE '%Acknowledgment of Risk, Release & Safety Agreement';
