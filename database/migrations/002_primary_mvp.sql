-- Primary MVP staff workflows. Additive; never rewrite migration 001.
ALTER TABLE membership_tiers ADD COLUMN kind TEXT NOT NULL DEFAULT 'membership' CHECK (kind IN ('membership','day_pass'));
ALTER TABLE membership_tiers ADD COLUMN benefits TEXT NOT NULL DEFAULT '';
ALTER TABLE membership_tiers ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE membership_tiers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "user" ADD COLUMN accessstatus TEXT NOT NULL DEFAULT 'active' CHECK (accessstatus IN ('active','suspended','revoked'));
ALTER TABLE "user" ADD COLUMN accessreason TEXT NOT NULL DEFAULT '';
ALTER TABLE "user" ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE user_membership ADD COLUMN plan_snapshot JSONB;
ALTER TABLE user_membership ADD COLUMN issued_by INTEGER REFERENCES "user"(userid);
ALTER TABLE user_membership ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE day_pass ADD COLUMN tierid INTEGER REFERENCES membership_tiers(tierid);
ALTER TABLE day_pass ADD COLUMN plan_snapshot JSONB;
ALTER TABLE day_pass ADD COLUMN issued_by INTEGER REFERENCES "user"(userid);
ALTER TABLE day_pass ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payment ADD COLUMN recorded_by INTEGER REFERENCES "user"(userid);
ALTER TABLE payment ADD COLUMN method TEXT NOT NULL DEFAULT 'unspecified';
ALTER TABLE payment ADD COLUMN reference TEXT NOT NULL DEFAULT '';
ALTER TABLE payment ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE payment ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payment ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE waiver ALTER COLUMN description TYPE TEXT;
ALTER TABLE waiver ADD COLUMN approval_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE waiver ADD COLUMN created_by INTEGER REFERENCES "user"(userid);
CREATE UNIQUE INDEX app_policy_version_unique ON waiver(name,version);

DO $$
DECLARE item TEXT[]; seq TEXT; maximum BIGINT;
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[ARRAY['membership_tiers','tierid'],ARRAY['payment','paymentid']] LOOP
    seq := 'app_' || item[1] || '_id_seq';
    EXECUTE format('CREATE SEQUENCE %I',seq);
    EXECUTE format('SELECT COALESCE(MAX(%I),0)+1 FROM %I',item[2],item[1]) INTO maximum;
    PERFORM setval(seq::regclass,GREATEST(maximum,1),false);
    EXECUTE format('ALTER SEQUENCE %I OWNED BY %I.%I',seq,item[1],item[2]);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT nextval(%L::regclass)',item[1],item[2],seq);
  END LOOP;
END $$;

CREATE TABLE app_staff_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES "user"(userid),
  subject_id INTEGER REFERENCES "user"(userid),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX app_staff_audit_subject ON app_staff_audit(subject_id,id DESC);
CREATE TABLE app_issuance_request (
  request_id UUID PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES "user"(userid),
  fingerprint CHAR(64) NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX app_membership_user ON user_membership(userid,startdate DESC);
CREATE INDEX app_day_pass_user ON day_pass(userid,validdate DESC);
CREATE INDEX app_payment_user ON payment(userid,paymentdate DESC);
