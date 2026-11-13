import type { Request, Response } from "express";
import type { Pool } from "pg";
import { transaction } from "../db.js";
import { AppError, integerId, positiveId, profileFields, textField } from "../domain.js";
import { authState } from "../middleware/auth.js";
import { UserModel } from "../models/UserModel.js";
import { EligibilityModel } from "../models/EligibilityModel.js";
import { AccessService, type AccessTarget } from "../services/AccessService.js";
import { MemberModel } from "../models/MemberModel.js";
import { StaffModel } from "../models/StaffModel.js";
import { page } from "../pagination.js";
import { oneOf, pageOffset } from "../staffDomain.js";
import { WaiverSigningService } from "../services/WaiverSigningService.js";
import { memberAccessEligibility, memberAccessReasonText } from "../eligibility.js";
import { waiverFormLines } from "../waiverForms.js";

export class MemberController {
  constructor(
    private pool: Pool,
    private timeZone: string,
  ) {}
  plans = async (_req: Request, res: Response) => {
    res.json({
      data: await new StaffModel(this.pool, this.timeZone).plans(true),
    });
  };
  memberships = async (_req: Request, res: Response) => {
    const model = new StaffModel(this.pool, this.timeZone),
      user = authState(res).user;
    const [memberships, passes] = await Promise.all([
      model.memberships(user.id),
      model.passes(user.id),
    ]);
    res.json({
      data: {
        memberships,
        passes,
        timeZone: this.timeZone,
        accessStatus: user.accessStatus,
      },
    });
  };
  payments = async (req: Request, res: Response) => {
    const offset = pageOffset(req.query.offset);
    res.json({
      data: page(
        await new StaffModel(this.pool, this.timeZone).payments(
          authState(res).user.id,
          offset,
        ),
        offset,
      ),
    });
  };
  certifications = async (_req: Request, res: Response) => {
    res.json({
      data: await new MemberModel(this.pool).certifications(
        authState(res).user.id,
      ),
    });
  };
  me = async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({
      data: await new UserModel(this.pool).profile(authState(res).user.id),
    });
  };
  studioContact = async (_req: Request, res: Response) => {
    const profile = await new UserModel(this.pool).profile(
      authState(res).user.id,
    );
    res.json({ data: profile?.studioContact });
  };
  profile = async (req: Request, res: Response) => {
    const address = profileFields(req.body.address, "Address");
    const contactPreferences = profileFields(
      req.body.contactPreferences,
      "Contact preferences",
    );
    const updated = await transaction(this.pool, async (db) => {
      const userId = authState(res).user.id;
      await db.query('SELECT userid FROM "user" WHERE userid=$1 FOR UPDATE', [
        userId,
      ]);
      const model = new UserModel(db, this.timeZone),
        before = await model.profile(userId);
      const updated = await model.updateProfile(
        authState(res).user.id,
        textField(req.body.firstName, "First name", 50),
        textField(req.body.lastName, "Last name", 50),
        textField(req.body.phone, "Phone", 15),
        address,
        contactPreferences,
      );
      await new StaffModel(db, this.timeZone).audit(
        userId,
        userId,
        "profile.updated",
        "user",
        userId,
        "Member updated profile",
        before,
        await model.profile(userId),
      );
      return updated;
    });
    res.json({
      data: updated ? await new UserModel(this.pool).profile(updated.id) : null,
    });
  };
  waivers = async (req: Request, res: Response) => {
    const { user } = authState(res);
    const signerName = `${user.firstName} ${user.lastName}`;
    const scope = req.query.scope === undefined ? undefined : oneOf(req.query.scope, ['facility', 'equipment'] as const, 'Policy applicability');
    const waivers = await new EligibilityModel(this.pool, this.timeZone).waivers(user.id, scope);
    // The form shows whose name the signature has to match, laid out by line kind.
    res.json({ data: waivers.map((waiver) => ({ ...waiver, formLines: waiverFormLines(waiver.description), signerName })) });
  };
  signWaiver = async (req: Request, res: Response) => {
    const id = positiveId(req.params.id);
    res.json({
      data: await new WaiverSigningService(this.pool, this.timeZone).sign(authState(res).user, id, req.body),
    });
  };
  overview = async (req: Request, res: Response) => {
    const userId = authState(res).user.id;
    const requestedBuildingId = req.query.buildingId === undefined ? undefined : integerId(req.query.buildingId,'Building');
    const model = new EligibilityModel(this.pool, this.timeZone);
    const [
      entitlement,
      waivers,
      checkInContext,
      reservations,
      checkIns,
    ] = await Promise.all([
      model.entitlement(userId, new Date()),
      model.waivers(userId, 'facility'),
      transaction(this.pool, async db => {
        const access = new AccessService(db,this.timeZone);
        const context = await access.facilityContext(userId,requestedBuildingId);
        try {
          await access.accessForTarget(userId,{buildingId:context.buildingId ?? undefined});
          return {...context, failure:null};
        } catch (error) {
          if (error instanceof AppError) return {...context, failure:{code:error.code, message:error.message}};
          throw error;
        }
      }),
      new MemberModel(this.pool).activeReservationCount(userId),
      new MemberModel(this.pool).recentCheckIns(userId),
    ]);
    // reasonCodes[i] identifies reasons[i]; a building check failure reports its AppError code.
    const accessCodes = memberAccessEligibility({
      accessStatus: authState(res).user.accessStatus,
      entitlement,
      facilityWaivers: waivers,
    });
    const reasons = accessCodes.map(memberAccessReasonText);
    const reasonCodes: string[] = [...accessCodes];
    if (checkInContext.failure && reasons.length === 0) {
      reasons.push(checkInContext.failure.message);
      reasonCodes.push(checkInContext.failure.code);
    }
    res.json({
      data: {
        entitlement,
        pendingWaivers: waivers.filter((w) => !w.signed).length,
        activeReservations: reservations,
        userId,
        canCheckIn: reasons.length === 0,
        checkInBuildingId: checkInContext.buildingId,
        buildings: checkInContext.buildings,
        reasons,
        reasonCodes,
        recentCheckIns: checkIns,
      },
    });
  };
  checkIn = async (req: Request, res: Response) => {
    const { user, actor } = authState(res);
    // A check-in starts a facility visit, which is what lets a sponsored minor in.
    // Only staff at the desk with the member's account open may record one here;
    // everyone, staff included, checks themselves in by tapping an NFC tag.
    if (!actor || actor.id === user.id || !actor.roles.some((role) => role === "staff" || role === "admin"))
      throw new AppError(403, "CHECK_IN_AT_READER", "Tap your NFC tag at the door, or ask staff to check you in.");
    const userId = user.id;
    const supplied = (['buildingId','roomId','equipmentId'] as const).filter(key => req.body[key] != null);
    if (supplied.length > 1) throw new AppError(400,'INVALID_INPUT','Choose one building, room, or equipment target.');
    const target: AccessTarget = {};
    for (const key of supplied) target[key] = positiveId(req.body[key],key);
    const record = await transaction(this.pool, async (db) => {
      const access = new AccessService(db, this.timeZone);
      const grant = await access.accessForTarget(userId,target);
      const checkIn = await new MemberModel(db, this.timeZone).createCheckIn(userId,grant.location,target.roomId ?? null,
        grant.buildingId,target.equipmentId ?? null,grant.reservationId);
      await new StaffModel(db, this.timeZone).audit(
        userId,
        userId,
        "check_in.created",
        "check_in",
        checkIn.id,
        "Member checked in",
        null,
        checkIn,
      );
      return checkIn;
    });
    res.status(201).json({ data: record });
  };
}
