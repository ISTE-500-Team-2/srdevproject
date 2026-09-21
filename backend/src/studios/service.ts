import type { Pool } from "pg";
import type Stripe from "stripe";
import { transaction, type Database } from "../db.js";
import { AppError, positiveId, textField } from "../domain.js";
import { UserModel } from "../models/UserModel.js";
import { PermissionModel } from "../models/PermissionModel.js";
import { enqueueNotification } from "../notifications/store.js";
import { monthlyWindow, refundDue, integer } from "./domain.js";
import { StudioStripe } from "./stripe.js";

export class StudioService {
  constructor(
    readonly pool: Pool,
    readonly zone = "America/New_York",
    readonly stripe?: StudioStripe,
  ) {}
  today() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  async actor(db: Database, id: number, staff = false, admin = false) {
    await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR SHARE', [id]);
    const user = await new UserModel(db).findById(id);
    if (!user || user.status !== "active" || user.accessStatus !== "active")
      throw new AppError(
        403,
        "ACCESS_DENIED",
        "Your account cannot perform this action.",
      );
    if (
      staff &&
      (!user.roles.some((r) => ["admin", "staff", "super-admin"].includes(r)) ||
        !(await new PermissionModel(db).allows(user, "payment", "update")))
    )
      throw new AppError(
        403,
        "STAFF_REQUIRED",
        "Payment-management permission is required.",
      );
    if (admin && !user.roles.some((r) => ["admin", "super-admin"].includes(r)))
      throw new AppError(
        403,
        "ADMIN_REQUIRED",
        "Administrator permission is required.",
      );
    return user;
  }
  async event(
    db: Database,
    r: any,
    actor: number | null,
    event: string,
    details: object = {},
  ) {
    await db.query(
      "INSERT INTO app_studio_event(rental_id,actor_id,event,details) VALUES($1,$2,$3,$4)",
      [r?.id ?? null, actor, event, JSON.stringify(details)],
    );
  }
  async notices(db: Database, r: any, kind: string) {
    const payload = {
      reservationId: r.id,
      resourceName: r.name ?? `Studio ${r.studio_id}`,
      startsAt: r.starts_on,
      endsAt: r.ends_on,
      amount: (r.amount_cents / 100).toFixed(2),
      currency: "USD",
      method: r.payment_method,
      reference: r.payment_reference ?? r.payment_intent ?? "",
      instructions:
        kind === "studio_reservation_cancelled"
          ? `Refund ${r.refund_cents / 100} USD; status ${r.payment_status}. Refunds return to the original payment method.`
          : "Your studio rental is confirmed.",
    };
    await enqueueNotification(db, {
      userId: r.userid,
      kind,
      dedupeKey: `studio:${r.id}:${kind}`,
      payload,
    });
    // Staff notification recipients are real studio accounts and retain their opt-out preferences.
    const staff = await db.query(
      "SELECT DISTINCT ur.userid FROM user_role ur JOIN role r USING(roleid) JOIN \"user\" u USING(userid) WHERE r.role IN ('admin','staff','super-admin') AND u.status='active'",
    );
    for (const row of staff.rows)
      if (row.userid !== r.userid)
        await enqueueNotification(db, {
          userId: row.userid,
          kind,
          dedupeKey: `studio:${r.id}:${kind}:staff:${row.userid}`,
          payload,
        });
  }
  async expireManual() {
    await this.pool.query(
      "UPDATE app_studio_rental SET status='expired' WHERE status='pending' AND payment_method='manual' AND hold_until<=now()",
    );
  }
  async list() {
    await this.expireManual();
    return (
      await this.pool.query(
        `SELECT s.*,COALESCE((SELECT json_agg(json_build_object('starts_on',r.starts_on,'ends_on',r.ends_on,'status',r.status,'hold_until',r.hold_until)) FROM app_studio_rental r WHERE r.studio_id=s.id AND r.status IN ('pending','confirmed')),'[]') AS availability FROM app_studio s WHERE s.active ORDER BY s.id`,
      )
    ).rows;
  }
  async mine(id: number) {
    return (
      await this.pool.query(
        "SELECT r.*,s.name FROM app_studio_rental r JOIN app_studio s ON s.id=r.studio_id WHERE r.userid=$1 ORDER BY r.created_at DESC",
        [id],
      )
    ).rows.map((r) => this.dates(r));
  }
  async staffList(id: number) {
    return transaction(this.pool, async (db) => {
      await this.actor(db, id, true);
      return (
        await db.query(
          'SELECT r.*,s.name,u.email FROM app_studio_rental r JOIN app_studio s ON s.id=r.studio_id JOIN "user" u ON u.userid=r.userid ORDER BY r.created_at DESC LIMIT 200',
        )
      ).rows.map((r) => this.dates(r));
    });
  }
  async configure(actor: number, id: number, body: any) {
    return transaction(this.pool, async (db) => {
      await this.actor(db, actor, false, true);
      if (
        !["full_before_start", "no_refunds"].includes(
          body.cancellationPolicy,
        ) ||
        body.policyConfirmed !== true
      )
        throw new AppError(
          400,
          "POLICY_REQUIRED",
          "Select and confirm the rental cancellation policy.",
        );
      const amount = integer(body.monthlyCents, 50, 10000000),
        revision = integer(body.revision, 1, 2147483647);
      const r = await db.query(
        "UPDATE app_studio SET monthly_cents=$2,cancellation_policy=$3,policy_confirmed=true,revision=revision+1 WHERE id=$1 AND revision=$4 RETURNING *",
        [id, amount, body.cancellationPolicy, revision],
      );
      if (!r.rows[0])
        throw new AppError(
          409,
          "STALE_RECORD",
          "Studio changed; refresh before saving.",
        );
      await this.event(db, null, actor, "studio_configured", {
        studioId: id,
        monthlyCents: amount,
        policy: body.cancellationPolicy,
      });
      return r.rows[0];
    });
  }
  async create(userid: number, body: any) {
    const { start, end } = monthlyWindow(body.startDate, this.today());
    const studioId = positiveId(body.studioId);
    if (
      typeof body.requestKey !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.requestKey,
      )
    )
      throw new AppError(
        400,
        "INVALID_REQUEST_KEY",
        "A unique request key is required.",
      );
    if (!["manual", "stripe_test"].includes(body.paymentMethod))
      throw new AppError(400, "INVALID_PAYMENT", "Choose a payment method.");
    if (body.paymentMethod === "stripe_test" && !this.stripe)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Card test checkout is not configured. Choose pay with staff.",
      );
    await this.expireManual();
    let rental;
    try {
      rental = await transaction(this.pool, async (db) => {
        const user = await this.actor(db, userid);
        if (!(await new PermissionModel(db).allows(user,"reservation","create",userid))) throw new AppError(403,"PERMISSION_DENIED","Reservation permission is required.");
        if (user.roles.some((r) => r.toLowerCase() === "instructor"))
          throw new AppError(
            403,
            "INSTRUCTOR_RESERVATION",
            "Instructor accounts cannot create reservations.",
          );
        if (user.membership !== "Monthly")
          throw new AppError(
            403,
            "MONTHLY_REQUIRED",
            "An active monthly subscription is required to rent a studio.",
          );
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext('studio-request'),hashtext($1))",
          [userid + ":" + body.requestKey],
        );
        const old = (
          await db.query(
            "SELECT * FROM app_studio_rental WHERE userid=$1 AND request_key=$2",
            [userid, body.requestKey],
          )
        ).rows[0];
        if (old) {
          if (
            old.studio_id !== studioId ||
            this.dates(old).starts_on !== start ||
            old.payment_method !== body.paymentMethod
          )
            throw new AppError(
              409,
              "KEY_REUSED",
              "Use a new request key for a different booking.",
            );
          return old;
        }
        const studio = (
          await db.query("SELECT * FROM app_studio WHERE id=$1 FOR UPDATE", [
            studioId,
          ])
        ).rows[0];
        if (
          !studio?.active ||
          !studio.policy_confirmed ||
          !studio.monthly_cents
        )
          throw new AppError(
            409,
            "STUDIO_NOT_CONFIGURED",
            "Staff must configure the studio rate and rental policy before booking.",
          );
        if (body.expectedRevision !== studio.revision)
          throw new AppError(
            409,
            "PRICE_CHANGED",
            "The studio rate or policy changed. Refresh and review it before booking.",
          );
        const row = (
          await db.query(
            `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,payment_method,request_key,hold_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '31 minutes') RETURNING *`,
            [
              studioId,
              userid,
              start,
              end,
              studio.monthly_cents,
              studio.cancellation_policy,
              body.paymentMethod,
              body.requestKey,
            ],
          )
        ).rows[0];
        await this.event(db, row, userid, "rental_held");
        return row;
      });
    } catch (e: any) {
      if (e.code === "23P01")
        throw new AppError(
          409,
          "STUDIO_CONFLICT",
          "Someone has already booked or is checking out this studio for those dates. Choose another space or date.",
        );
      throw e;
    }
    rental = this.dates(rental);
    if (
      rental.payment_method === "stripe_test" &&
      rental.status === "pending"
    ) {
      const session = rental.checkout_id
        ? await this.stripe!.sdk.checkout.sessions.retrieve(rental.checkout_id)
        : await this.stripe!.checkout(rental);
      await this.pool.query(
        "UPDATE app_studio_rental SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL",
        [rental.id, session.id],
      );
      return { ...rental, checkoutUrl: session.url };
    }
    return rental;
  }
  dates(r: any) {
    return {
      ...r,
      starts_on:
        typeof r.starts_on === "string"
          ? r.starts_on
          : `${r.starts_on.getFullYear()}-${String(r.starts_on.getMonth() + 1).padStart(2, "0")}-${String(r.starts_on.getDate()).padStart(2, "0")}`,
      ends_on:
        typeof r.ends_on === "string"
          ? r.ends_on
          : `${r.ends_on.getFullYear()}-${String(r.ends_on.getMonth() + 1).padStart(2, "0")}-${String(r.ends_on.getDate()).padStart(2, "0")}`,
    };
  }
  async manualPay(actor: number, id: number, reference: unknown) {
    return transaction(this.pool, async (db) => {
      await this.actor(db, actor, true);
      const r = (
        await db.query(
          "SELECT * FROM app_studio_rental WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        !r ||
        r.payment_method !== "manual" ||
        r.status !== "pending" ||
        new Date(r.hold_until) <= new Date()
      )
        throw new AppError(
          409,
          "PAYMENT_STATE",
          "This manual hold is no longer payable.",
        );
      const ref = textField(reference, "Receipt/reference", 200, 3);
      const result = (
        await db.query(
          "UPDATE app_studio_rental SET status='confirmed',payment_status='paid',payment_reference=$2 WHERE id=$1 RETURNING *",
          [id, ref],
        )
      ).rows[0];
      await this.event(db, result, actor, "manual_payment_recorded", {
        reference: ref,
      });
      await this.notices(
        db,
        this.dates(result),
        "studio_reservation_confirmed",
      );
      return result;
    });
  }
  async cancel(userid: number, id: number) {
    const initial = (
      await this.pool.query(
        "SELECT * FROM app_studio_rental WHERE id=$1 AND userid=$2",
        [id, userid],
      )
    ).rows[0];
    if (!initial) throw new AppError(404, "NOT_FOUND", "Rental not found.");
    if (initial.payment_method === "stripe_test" && !this.stripe)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Card test payments are not configured; contact staff.",
      );
    if (
      initial.payment_method === "stripe_test" &&
      initial.status === "pending"
    ) {
      if (!initial.checkout_id)
        throw new AppError(
          409,
          "PAYMENT_RECONCILE",
          "Resume checkout once before cancelling this pending payment.",
        );
      let session = await this.stripe!.sdk.checkout.sessions.retrieve(
        initial.checkout_id,
      );
      if (session.status === "open")
        session = await this.stripe!.sdk.checkout.sessions.expire(session.id);
      if (session.payment_status === "paid") await this.complete(session);
      else if (session.status !== "expired")
        throw new AppError(
          409,
          "PAYMENT_PROCESSING",
          "Payment is processing. Wait for verification before cancelling.",
        );
    }
    const result = await transaction(this.pool, async (db) => {
      const user = await this.actor(db, userid);
      if (!(await new PermissionModel(db).allows(user,"reservation","update",userid))) throw new AppError(403,"PERMISSION_DENIED","Cancellation permission is required.");
      let r = (
        await db.query(
          "SELECT * FROM app_studio_rental WHERE id=$1 AND userid=$2 FOR UPDATE",
          [id, userid],
        )
      ).rows[0];
      r = this.dates(r);
      if (r.status === "cancelled" || r.status === "expired") return r;
      const refund =
        r.payment_status === "paid" ? refundDue(r, this.today()) : 0;
      const result = (
        await db.query(
          "UPDATE app_studio_rental SET status='cancelled',refund_cents=$2,payment_status=CASE WHEN $2>0 THEN 'refund_pending' ELSE payment_status END WHERE id=$1 RETURNING *",
          [id, refund],
        )
      ).rows[0];
      await this.event(db, result, userid, "rental_cancelled", {
        refundCents: refund,
      });
      await this.notices(
        db,
        this.dates(result),
        "studio_reservation_cancelled",
      );
      return result;
    });
    if (
      result.payment_method === "stripe_test" &&
      result.refund_cents > 0 &&
      ["refund_pending", "refund_failed"].includes(result.payment_status)
    )
      await this.retryRefund(result.id);
    return (
      await this.pool.query("SELECT * FROM app_studio_rental WHERE id=$1", [id])
    ).rows[0];
  }
  async syncPayment(userid: number, id: number) {
    const r = (
      await this.pool.query(
        "SELECT * FROM app_studio_rental WHERE id=$1 AND userid=$2",
        [id, userid],
      )
    ).rows[0];
    if (!r) throw new AppError(404, "NOT_FOUND", "Rental not found.");
    if (r.payment_method !== "stripe_test" || r.status !== "pending")
      return this.dates(r);
    if (!this.stripe)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Card test payments are not configured; contact staff.",
      );
    let session;
    try {
      session = r.checkout_id
        ? await this.stripe.sdk.checkout.sessions.retrieve(r.checkout_id)
        : await this.stripe.checkout(this.dates(r));
    } catch {
      throw new AppError(
        502,
        "PAYMENT_RECONCILE",
        "Could not reconcile this checkout. The hold is preserved to prevent double booking; contact staff.",
      );
    }
    await this.pool.query(
      "UPDATE app_studio_rental SET checkout_id=$2 WHERE id=$1 AND checkout_id IS NULL",
      [id, session.id],
    );
    if (session.payment_status === "paid") await this.complete(session);
    else {
      if (session.status === "open" && new Date(r.hold_until) <= new Date())
        session = await this.stripe.sdk.checkout.sessions.expire(session.id);
      if (session.status === "expired")
        await this.pool.query(
          "UPDATE app_studio_rental SET status='expired' WHERE id=$1 AND status='pending' AND payment_status='unpaid'",
          [id],
        );
    }
    return {
      ...this.dates(
        (
          await this.pool.query("SELECT * FROM app_studio_rental WHERE id=$1", [
            id,
          ])
        ).rows[0],
      ),
      checkoutUrl: session.status === "open" ? session.url : null,
    };
  }
  async retryRefund(id: number) {
    const r = (
      await this.pool.query("SELECT * FROM app_studio_rental WHERE id=$1", [id])
    ).rows[0];
    if (
      !r ||
      r.status !== "cancelled" ||
      r.payment_method !== "stripe_test" ||
      !r.refund_cents ||
      !["refund_pending", "refund_failed"].includes(r.payment_status)
    )
      return;
    if (!this.stripe)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Stripe is not configured.",
      );
    try {
      const refund = await this.stripe.refund(r);
      await transaction(this.pool, (db) => this.applyRefund(db, refund));
      if (["failed", "canceled"].includes(refund.status ?? "")) throw new AppError(409,"REFUND_RECONCILE","Stripe reports a terminal refund failure. Staff must reconcile the original-method refund in Stripe; no new refund was issued.");
    } catch (error) {
      if (error instanceof AppError && error.code === "REFUND_RECONCILE") throw error;
      await this.pool.query(
        "UPDATE app_studio_rental SET payment_status='refund_failed' WHERE id=$1 AND payment_status='refund_pending'",
        [id],
      );
      throw new AppError(
        502,
        "REFUND_PENDING",
        "Booking cancelled; refund needs retry by staff.",
      );
    }
  }
  async manualRefund(actor: number, id: number, reference: unknown) {
    return transaction(this.pool, async (db) => {
      await this.actor(db, actor, true);
      const ref = textField(
        reference,
        "Original-method refund reference",
        200,
        3,
      );
      const r = (
        await db.query(
          "UPDATE app_studio_rental SET payment_status='refunded',refund_reference=$2 WHERE id=$1 AND status='cancelled' AND payment_method='manual' AND payment_status='refund_pending' RETURNING *",
          [id, ref],
        )
      ).rows[0];
      if (!r)
        throw new AppError(
          409,
          "REFUND_STATE",
          "No pending manual refund for this rental.",
        );
      await this.event(db, r, actor, "manual_refund_recorded", {
        reference: ref,
      });
      await enqueueNotification(db, {
        userId: r.userid,
        kind: "payment_refunded",
        dedupeKey: `studio-refund:${r.id}`,
        payload: {
          amount: (r.refund_cents / 100).toFixed(2),
          currency: "USD",
          reference: ref,
          method: "Original payment method",
        },
      });
      return r;
    });
  }
  async complete(session: Stripe.Checkout.Session, db?: Database) {
    const work = async (db: Database) => {
      if (session.livemode || session.payment_status !== "paid") return;
      let r = (
        await db.query(
          "SELECT * FROM app_studio_rental WHERE id=$1 FOR UPDATE",
          [Number(session.metadata?.studioRentalId) || 0],
        )
      ).rows[0];
      if (
        !r ||
        r.payment_method !== "stripe_test" ||
        session.amount_total !== r.amount_cents ||
        session.currency !== "usd" ||
        String(r.id) !== session.client_reference_id ||
        (r.checkout_id && r.checkout_id !== session.id)
      )
        throw new AppError(
          400,
          "PAYMENT_MISMATCH",
          "Checkout does not match rental.",
        );
      if (r.payment_status === "paid" || r.status === "cancelled") return;
      if (r.status !== "pending")
        throw new AppError(
          409,
          "PAYMENT_STATE",
          "Payment requires staff reconciliation.",
        );
      const intent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      if (!intent)
        throw new AppError(400, "PAYMENT_MISMATCH", "Payment intent missing.");
      r = (
        await db.query(
          "UPDATE app_studio_rental SET checkout_id=$2,payment_intent=$3,status='confirmed',payment_status='paid' WHERE id=$1 RETURNING *",
          [r.id, session.id, intent],
        )
      ).rows[0];
      await this.event(db, r, null, "stripe_payment_confirmed");
      await this.notices(db, this.dates(r), "studio_reservation_confirmed");
    };
    return db ? work(db) : transaction(this.pool, work);
  }
  async applyRefund(db: Database, f: Stripe.Refund) {
    if (!f.metadata?.studioRentalId || f.currency !== "usd") return;
    const r = (
      await db.query(
        "UPDATE app_studio_rental SET refund_id=$2,payment_status=$3 WHERE payment_intent=$1 AND status='cancelled' AND refund_cents=$4 AND id=$5 AND payment_status IN ('refund_pending','refund_failed') AND NOT(payment_status='refund_failed' AND $3='refund_pending') RETURNING *",
        [
          typeof f.payment_intent === "string"
            ? f.payment_intent
            : f.payment_intent?.id,
          f.id,
          f.status === "succeeded"
            ? "refunded"
            : ["failed","canceled"].includes(f.status ?? "")
              ? "refund_failed"
              : "refund_pending",
          f.amount,
          Number(f.metadata.studioRentalId),
        ],
      )
    ).rows[0];
    if (r) {
      await this.event(db, r, null, "stripe_refund_updated", {
        refundId: f.id,
        status: f.status,
      });
      if (r.payment_status === "refunded")
        await enqueueNotification(db, {
          userId: r.userid,
          kind: "payment_refunded",
          dedupeKey: `studio-refund:${r.id}`,
          payload: {
            amount: (r.refund_cents / 100).toFixed(2),
            currency: "USD",
            reference: f.id,
            method: "Original card (test mode)",
          },
        });
    }
  }
  async webhook(event: Stripe.Event) {
    if (event.livemode)
      throw new AppError(
        400,
        "LIVE_PAYMENT_FORBIDDEN",
        "Only test events accepted.",
      );
    return transaction(this.pool, async (db) => {
      if (
        !(
          await db.query(
            "INSERT INTO app_studio_stripe_event(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
            [event.id],
          )
        ).rowCount
      )
        return;
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      )
      {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.studioRentalId) await this.complete(session, db);
      }
      if (event.type === "checkout.session.expired") {
        const s = event.data.object as Stripe.Checkout.Session;
        await db.query(
          "UPDATE app_studio_rental SET status='expired' WHERE checkout_id=$1 AND status='pending' AND payment_status='unpaid'",
          [s.id],
        );
      }
      if (
        event.type === "refund.updated" ||
        event.type === "refund.created" ||
        event.type === "refund.failed"
      ) {
        const f = event.data.object as Stripe.Refund;
        if (!f.metadata?.studioRentalId) return;
        await this.applyRefund(db, f);
      }
    });
  }
}
