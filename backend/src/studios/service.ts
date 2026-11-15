import { MinorSupervision } from "../minorSupervision.js";
import type { Pool } from "pg";
import type Stripe from "stripe";
import { transaction, type Database } from "../db.js";
import { AppError, positiveId, textField } from "../domain.js";
import { PermissionModel } from "../models/PermissionModel.js";
import { enqueueNotification } from "../notifications/store.js";
import { monthlyWindow, refundDue, integer } from "./domain.js";
import { StudioStripe } from "./stripe.js";
import { DEFAULT_BUILDING_ID } from "../facility.js";
import { requireActor } from "../accountPolicy.js";
import { businessToday } from "../businessDate.js";
import { studioRefundDecision, studioRefundState } from "./refundDecision.js";
import type {
  NamedStudioRentalRow,
  StudioConfigureRequest,
  StudioRentalRequest,
  StudioRentalRow,
  StudioRow,
  WithRentalDates,
} from "./rows.js";

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value);

export class StudioService {
  constructor(
    readonly pool: Pool,
    readonly zone = "America/New_York",
    readonly stripe?: StudioStripe,
  ) {}
  async event(
    db: Database,
    r: Pick<StudioRentalRow, "id"> | null,
    actor: number | null,
    event: string,
    details: object = {},
  ) {
    await db.query(
      "INSERT INTO app_studio_event(rental_id,actor_id,event,details) VALUES($1,$2,$3,$4)",
      [r?.id ?? null, actor, event, JSON.stringify(details)],
    );
  }
  async notices(
    db: Database,
    r: WithRentalDates<StudioRentalRow> & { name?: string },
    kind: "studio_reservation_confirmed" | "studio_reservation_cancelled",
  ) {
    const payload = {
      reservationId: r.id,
      resourceName: r.name ?? `Studio ${r.studio_id}`,
      startsAt: r.starts_on,
      endsAt: r.ends_on,
      amount: (r.amount_cents / 100).toFixed(2),
      currency: "USD",
      method: r.payment_method,
      reference: r.payment_reference ?? r.payment_intent ?? "",
      paymentStatus: r.payment_status,
      ...(kind === "studio_reservation_cancelled" && {
        refundAmount: ((r.refund_cents ?? 0) / 100).toFixed(2),
      }),
    };
    await enqueueNotification(db, {
      userId: r.userid,
      kind,
      dedupeKey: `studio:${r.id}:${kind}`,
      payload,
    });
    // Staff notification recipients are real studio accounts and retain their opt-out preferences.
    const staff = await db.query<{ userid: number }>(
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
      await this.pool.query<NamedStudioRentalRow>(
        "SELECT r.*,s.name FROM app_studio_rental r JOIN app_studio s ON s.id=r.studio_id WHERE r.userid=$1 ORDER BY r.created_at DESC",
        [id],
      )
    ).rows.map((r) => this.dates(r));
  }
  async staffList(id: number) {
    return transaction(this.pool, async (db) => {
      await requireActor(db, id, { staff: true, zone: this.zone });
      return (
        await db.query<NamedStudioRentalRow & { email: string; member_name: string }>(
          `SELECT r.*,s.name,u.email,u.firstname||' '||u.lastname AS member_name FROM app_studio_rental r JOIN app_studio s ON s.id=r.studio_id JOIN "user" u ON u.userid=r.userid ORDER BY r.created_at DESC LIMIT 200`,
        )
      ).rows.map((r) => this.dates(r));
    });
  }
  async configure(actor: number, id: number, body: StudioConfigureRequest) {
    return transaction(this.pool, async (db) => {
      await requireActor(db, actor, { admin: true, zone: this.zone });
      if (
        !oneOf(["full_before_start", "no_refunds"], body.cancellationPolicy) ||
        body.policyConfirmed !== true
      )
        throw new AppError(
          400,
          "POLICY_REQUIRED",
          "Select and confirm the rental cancellation policy.",
        );
      const amount = integer(body.monthlyCents, 50, 10000000),
        revision = integer(body.revision, 1, 2147483647);
      const r = await db.query<StudioRow>(
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
  async create(
    userid: number,
    body: StudioRentalRequest,
  ): Promise<WithRentalDates<StudioRentalRow> & { checkoutUrl?: string | null }> {
    const { start, end } = monthlyWindow(body.startDate, businessToday(this.zone));
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
    if (!oneOf(["manual", "stripe_test"], body.paymentMethod))
      throw new AppError(400, "INVALID_PAYMENT", "Choose a payment method.");
    if (body.paymentMethod === "stripe_test" && !this.stripe)
      throw new AppError(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Card test checkout is not configured. Choose pay with staff.",
      );
    await this.expireManual();
    const requestKey = body.requestKey,
      paymentMethod = body.paymentMethod;
    let held: StudioRentalRow;
    try {
      held = await transaction(this.pool, async (db) => {
        const user = await requireActor(db, userid, { zone: this.zone });
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
          [userid + ":" + requestKey],
        );
        const old = (
          await db.query<StudioRentalRow>(
            "SELECT * FROM app_studio_rental WHERE userid=$1 AND request_key=$2",
            [userid, requestKey],
          )
        ).rows[0];
        if (old) {
          if (
            old.studio_id !== studioId ||
            this.dates(old).starts_on !== start ||
            old.payment_method !== paymentMethod
          )
            throw new AppError(
              409,
              "KEY_REUSED",
              "Use a new request key for a different booking.",
            );
          return old;
        }
        // After the replay lookup: retrying a created rental must not need the adult still present.
        // Studios are all in the main building until studios carry their own building.
        await new MinorSupervision(db,this.zone).requireSponsor(userid,DEFAULT_BUILDING_ID);
        const studio = (
          await db.query<StudioRow>("SELECT * FROM app_studio WHERE id=$1 FOR UPDATE", [
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
            "The studio rate or terms just changed. Review the current price, then book again.",
          );
        const row = (
          await db.query<StudioRentalRow>(
            `INSERT INTO app_studio_rental(studio_id,userid,starts_on,ends_on,amount_cents,cancellation_policy,payment_method,request_key,hold_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '31 minutes') RETURNING *`,
            [
              studioId,
              userid,
              start,
              end,
              studio.monthly_cents,
              studio.cancellation_policy,
              paymentMethod,
              requestKey,
            ],
          )
        ).rows[0]!;
        await new MinorSupervision(db,this.zone).recordBooking(userid,row.id,true);
        await this.event(db, row, userid, "rental_held");
        return row;
      });
    } catch (e) {
      if ((e as { code?: unknown }).code === "23P01")
        throw new AppError(
          409,
          "STUDIO_CONFLICT",
          "Someone has already booked or is checking out this studio for those dates. Choose another space or date.",
        );
      throw e;
    }
    const rental = this.dates(held);
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
  dates<T extends { starts_on: Date | string; ends_on: Date | string }>(
    r: T,
  ): WithRentalDates<T> {
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
      await requireActor(db, actor, { staff: true, zone: this.zone });
      const r = (
        await db.query<StudioRentalRow>(
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
        await db.query<StudioRentalRow>(
          "UPDATE app_studio_rental SET status='confirmed',payment_status='paid',payment_reference=$2 WHERE id=$1 RETURNING *",
          [id, ref],
        )
      ).rows[0]!;
      await this.receipt(db, result, ref);
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
      await this.pool.query<StudioRentalRow>(
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
      const user = await requireActor(db, userid, { zone: this.zone });
      if (!(await new PermissionModel(db).allows(user,"reservation","update",userid))) throw new AppError(403,"PERMISSION_DENIED","Cancellation permission is required.");
      const r = this.dates(
        (
          await db.query<StudioRentalRow>(
            "SELECT * FROM app_studio_rental WHERE id=$1 AND userid=$2 FOR UPDATE",
            [id, userid],
          )
        ).rows[0]!,
      );
      if (r.status === "cancelled" || r.status === "expired") return r;
      // End dates are exclusive: from ends_on the month is over, so there is
      // nothing left to free up or refund.
      if (businessToday(this.zone) >= r.ends_on)
        throw new AppError(
          409,
          "RENTAL_ENDED",
          "This rental has already ended, so it can't be cancelled.",
        );
      const refund =
        r.payment_status === "paid" ? refundDue(r, businessToday(this.zone)) : 0;
      const result = (
        await db.query<StudioRentalRow>(
          "UPDATE app_studio_rental SET status='cancelled',refund_cents=$2,payment_status=CASE WHEN $2>0 THEN 'refund_pending' ELSE payment_status END WHERE id=$1 RETURNING *",
          [id, refund],
        )
      ).rows[0]!;
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
      await this.pool.query<StudioRentalRow>("SELECT * FROM app_studio_rental WHERE id=$1", [id])
    ).rows[0];
  }
  async syncPayment(userid: number, id: number) {
    const r = (
      await this.pool.query<StudioRentalRow>(
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
      // Completed delayed-payment checkouts cannot be expired through Stripe.
      // Reconcile a failed intent if its webhook was missed; keep processing or
      // ambiguous payments held rather than releasing dates prematurely.
      if(session.status==='complete' && session.payment_status==='unpaid' && session.payment_intent) {
        const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent.id;
        const intent=await this.stripe.sdk.paymentIntents.retrieve(pi);
        if(intent.id!==pi||intent.livemode||intent.amount!==r.amount_cents||intent.currency!=='usd')
          throw new AppError(400,'PAYMENT_MISMATCH','Payment intent does not match rental.');
        if(intent.status==='canceled'||intent.status==='requires_payment_method'&&intent.last_payment_error)
          await this.failedCheckout(session);
      }
      if (session.status === "expired")
        await this.pool.query(
          "UPDATE app_studio_rental SET status='expired' WHERE id=$1 AND status='pending' AND payment_status='unpaid'",
          [id],
        );
    }
    return {
      ...this.dates(
        (
          await this.pool.query<StudioRentalRow>("SELECT * FROM app_studio_rental WHERE id=$1", [
            id,
          ])
        ).rows[0]!,
      ),
      checkoutUrl: session.status === "open" ? session.url : null,
    };
  }
  async retryRefund(id: number) {
    const r = (
      await this.pool.query<StudioRentalRow>("SELECT * FROM app_studio_rental WHERE id=$1", [id])
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
      await requireActor(db, actor, { staff: true, zone: this.zone });
      const ref = textField(
        reference,
        "Original-method refund reference",
        200,
        3,
      );
      const r = (
        await db.query<StudioRentalRow>(
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
        await db.query<StudioRentalRow>(
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
        await db.query<StudioRentalRow>(
          "UPDATE app_studio_rental SET checkout_id=$2,payment_intent=$3,status='confirmed',payment_status='paid' WHERE id=$1 RETURNING *",
          [r.id, session.id, intent],
        )
      ).rows[0]!;
      await this.receipt(db, r, intent);
      await this.event(db, r, null, "stripe_payment_confirmed");
      await this.notices(db, this.dates(r), "studio_reservation_confirmed");
    };
    return db ? work(db) : transaction(this.pool, work);
  }
  async failedCheckout(session: Stripe.Checkout.Session, db?: Database) {
    const work=async(db:Database)=>{
      const r=(await db.query<StudioRentalRow>("SELECT * FROM app_studio_rental WHERE checkout_id=$1 OR id::text=$2 FOR UPDATE",[session.id,session.metadata?.studioRentalId??''])).rows[0];
      if(!r)return;
      if(session.livemode||session.mode!=='payment'||session.amount_total!==r.amount_cents||session.currency!=='usd'||session.client_reference_id!==String(r.id)||r.checkout_id&&session.id!==r.checkout_id)
        throw new AppError(400,'PAYMENT_MISMATCH','Failed checkout does not match rental.');
      if(session.payment_status==='paid'){await this.complete(session,db);return;}
      if(session.status!=='complete'||session.payment_status!=='unpaid'||r.status!=='pending'||r.payment_status!=='unpaid')return;
      await db.query("UPDATE app_studio_rental SET status='expired',checkout_id=$2 WHERE id=$1",[r.id,session.id]);
      await this.event(db,r,null,'stripe_payment_failed',{checkoutId:session.id});
      await enqueueNotification(db,{userId:r.userid,kind:'payment_failed',dedupeKey:`studio-payment-failed:${r.id}`,payload:{reservationId:r.id,reference:session.id,instructions:'The studio payment failed. The dates have been released; start a new booking to try again.'}});
    };
    return db?work(db):transaction(this.pool,work);
  }
  async receipt(db: Database, r: StudioRentalRow, reference: string) {
    await enqueueNotification(db, {
      userId: r.userid, kind: "payment_receipt", dedupeKey: `studio-payment:${r.id}`,
      payload: {amount: (r.amount_cents / 100).toFixed(2), currency: "USD",
        reference, reservationId: r.id, method: r.payment_method === "stripe_test" ? "Card (test mode)" : "Staff-recorded payment",
        startsAt: this.dates(r).starts_on, endsAt: this.dates(r).ends_on},
    });
  }
  async applyRefund(db: Database, f: Stripe.Refund) {
    if (!f.metadata?.studioRentalId || f.currency !== "usd") return;
    // A refund for another payment, rental or amount is ignored.
    const rental = (
      await db.query<StudioRentalRow>(
        "SELECT * FROM app_studio_rental WHERE payment_intent=$1 AND status='cancelled' AND refund_cents=$2 AND id=$3 FOR UPDATE",
        [
          typeof f.payment_intent === "string"
            ? f.payment_intent
            : f.payment_intent?.id,
          f.amount,
          Number(f.metadata.studioRentalId),
        ],
      )
    ).rows[0];
    if (
      !rental ||
      studioRefundDecision(
        { paymentStatus: rental.payment_status, refundId: rental.refund_id },
        f,
      ) === "skip"
    )
      return;
    const r = (
      await db.query<StudioRentalRow>(
        "UPDATE app_studio_rental SET refund_id=$2,payment_status=$3 WHERE id=$1 RETURNING *",
        [rental.id, f.id, studioRefundState(f.status)],
      )
    ).rows[0];
    if (r) {
      await this.event(db, r, null, "stripe_refund_updated", {
        refundId: f.id,
        status: f.status,
      });
      if(r.payment_status==='refund_failed') {
        await db.query("UPDATE app_notification_outbox SET status='obsolete',updated_at=now() WHERE dedupe_key=ANY($1::text[]) AND status='pending'",[[`studio-refund:${r.id}`,`studio-refund:${r.id}:${f.id}`]]);
        await enqueueNotification(db,{userId:r.userid,kind:'payment_status_changed',dedupeKey:`studio-refund-failed:${r.id}:${f.id}`,
          payload:{reservationId:r.id,reference:f.id,amount:(r.refund_cents/100).toFixed(2),currency:'USD',instructions:'The original-card refund failed. Staff must reconcile it; the booking remains cancelled.'}});
      }
      if (r.payment_status === "refunded")
        await enqueueNotification(db, {
          userId: r.userid,
          kind: "payment_refunded",
          dedupeKey: `studio-refund:${r.id}:${f.id}`,
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
        const session = event.data.object;
        if (session.metadata?.studioRentalId) await this.complete(session, db);
      }
      if(event.type==='checkout.session.async_payment_failed') {
        const announced=event.data.object;
        const r=(await db.query<{ id: number }>("SELECT id FROM app_studio_rental WHERE checkout_id=$1 OR id::text=$2 FOR UPDATE",[announced.id,announced.metadata?.studioRentalId??''])).rows[0];
        if(r){
          if(!this.stripe)throw new AppError(503,'PAYMENTS_UNAVAILABLE','Stripe is not configured.');
          const current=await this.stripe.sdk.checkout.sessions.retrieve(announced.id);
          if(current.id!==announced.id)throw new AppError(400,'PAYMENT_MISMATCH','Checkout identity mismatch.');
          await this.failedCheckout(current,db);
        }
      }
      if (event.type === "checkout.session.expired") {
        const s = event.data.object;
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
        const announced = event.data.object;
        // Match an established refund/intent binding, not untrusted metadata alone.
        const intent=typeof announced.payment_intent==='string'?announced.payment_intent:announced.payment_intent?.id;
        const rental=(await db.query<{ id: number }>("SELECT id FROM app_studio_rental WHERE payment_intent=$1 AND status='cancelled' AND (refund_id=$2 OR id::text=$3) FOR UPDATE",[intent,announced.id,announced.metadata?.studioRentalId??''])).rows[0];
        if(!rental)return;
        if(!this.stripe)throw new AppError(503,'PAYMENTS_UNAVAILABLE','Stripe is not configured.');
        // A delayed success/failure payload must not overwrite Stripe's current state.
        const current=await this.stripe.sdk.refunds.retrieve(announced.id);
        if(current.id!==announced.id||(typeof current.payment_intent==='string'?current.payment_intent:current.payment_intent?.id)!==intent)
          throw new AppError(400,'PAYMENT_MISMATCH','Refund payment intent mismatch.');
        await this.applyRefund(db,{...current,metadata:{...current.metadata,studioRentalId:String(rental.id)}});
      }
    });
  }
}
