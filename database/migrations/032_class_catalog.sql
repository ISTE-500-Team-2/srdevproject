-- Sponsor-provided descriptions are templates, not fabricated scheduled/paid classes.
CREATE TABLE app_class_catalog (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title VARCHAR(100) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 15 CHECK(capacity BETWEEN 1 AND 15)
);
INSERT INTO app_class_catalog(title,description) VALUES
('Pour, Swirl & Serve: Resin Charcuterie Board','Make a one-of-a-kind serving board with a hardwood base and a bold resin edge or river. You’ll pick your pigments, mica, and accents, learn how to mix and pour, and finish with food-safe sealing tips so your board is ready to show off. You’ll leave with your piece curing and pick it up after it sets. No experience needed.'),
('Custom Epoxy Resin Platter','Design a statement platter for entertaining or display. Learn to layer color, build cells and lacing effects, and add metallic leaf, crushed glass, or dried botanicals. We’ll cover mixing ratios, timing, and finishing, so you understand each step and can repeat it at home. Beginners welcome.'),
('Framed Resin & Glass Art','Make wall-ready art by combining broken and tumbled glass with layered resin inside a frame. Explore color, depth, and light as you build ocean scenes, abstracts, or geode-style designs. You’ll learn how to work in layers and seal the piece, and you’ll take home a framed original. All materials provided.'),
('Glow Up: Floral Resin Nightlight','Preserve real dried flowers in a glowing resin nightlight. You’ll arrange botanicals in a mold, pour clear and tinted resin, and fit your piece onto an LED base. It makes a great keepsake, gift, or way to save flowers from a special occasion. No experience needed.');
ALTER TABLE app_training_class ADD COLUMN catalog_id INTEGER REFERENCES app_class_catalog(id);
ALTER TABLE app_training_class ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE app_training_class ALTER COLUMN certification_id DROP NOT NULL;
-- Historical larger classes are preserved; new/updated classes must respect the sponsor cap.
CREATE FUNCTION app_limit_class_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capacity>15 AND (TG_OP='INSERT' OR NEW.capacity IS DISTINCT FROM OLD.capacity) THEN
    RAISE EXCEPTION 'Classes are limited to 15 participants' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_class_capacity_15 BEFORE INSERT OR UPDATE OF capacity ON app_training_class
FOR EACH ROW EXECUTE FUNCTION app_limit_class_capacity();
CREATE TABLE app_training_requirement (
  certification_id INTEGER PRIMARY KEY REFERENCES certifications(certid),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes>0),
  fee_cents INTEGER NOT NULL CHECK(fee_cents>=0)
);
CREATE TABLE app_equipment_retirement (
  equipment_id INTEGER PRIMARY KEY REFERENCES equipment(equipmentid),
  reason TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE tab text; key text; BEGIN
  FOREACH tab IN ARRAY ARRAY['app_class_catalog','app_training_requirement','app_equipment_retirement'] LOOP
    key:=CASE tab WHEN 'app_class_catalog' THEN 'id' WHEN 'app_training_requirement' THEN 'certification_id' ELSE 'equipment_id' END;
    EXECUTE format('CREATE TRIGGER app_capture_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_capture_change(%L)',tab,key);
    EXECUTE format('CREATE TRIGGER app_no_unlogged_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_reject_audit_mutation()',tab);
  END LOOP;
END $$;
