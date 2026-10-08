-- Scheduled instructor-led training; room slots use existing reservation conflicts.
CREATE TABLE app_training_class (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 title VARCHAR(100) NOT NULL,
 certification_id INTEGER NOT NULL REFERENCES certifications(certid),
 instructor_id INTEGER NOT NULL REFERENCES "user"(userid),
 reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservation(reservationid),
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 500),
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by INTEGER NOT NULL REFERENCES "user"(userid)
);
CREATE TABLE app_training_enrollment (
 class_id INTEGER NOT NULL REFERENCES app_training_class(id),
 user_id INTEGER NOT NULL REFERENCES "user"(userid),
 status TEXT NOT NULL DEFAULT 'enrolled' CHECK(status IN ('enrolled','cancelled','attended','no_show')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(class_id,user_id)
);
