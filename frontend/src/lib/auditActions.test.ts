import { describe, expect, it } from "vitest";
import { actionTitle, auditArea, describeAudit, fieldLabel, formatFieldValue } from "./auditActions";

describe("change log wording", () => {
  it("names staff actions, database writes and card taps", () => {
    expect(actionTitle("equipment.taken_out_of_service")).toBe("Taken out of service");
    expect(actionTitle("app_service_notice.update")).toBe("Service notice updated");
    expect(actionTitle("app_notification_outbox.insert")).toBe("Email queued");
    expect(actionTitle("app_mystery_table.delete")).toBe("Mystery table deleted");
    expect(actionTitle("brand_new.thing_done")).toBe("Brand new thing done");
    expect(describeAudit({ action: "app_device_access_event.insert", entityType: "app_device_access_event", allowed: false })).toEqual({
      title: "Card tap denied",
      tone: "bad",
      area: "access",
    });
  });

  it("puts every action in the most specific area", () => {
    expect(auditArea("user.access_suspended")).toBe("access");
    expect(auditArea("user.role_changed")).toBe("accounts");
    expect(auditArea("user_membership.insert")).toBe("memberships");
    expect(auditArea("app_equipment_checkout.insert")).toBe("billing");
    expect(auditArea("app_equipment_retirement.insert")).toBe("equipment");
    expect(auditArea("something.else")).toBe("other");
  });

  it("marks what opened or closed something", () => {
    const tone = (action: string) => describeAudit({ action, entityType: "x", allowed: null }).tone;
    expect(tone("training.approved")).toBe("good");
    expect(tone("minor.sponsor_unlinked")).toBe("bad");
    expect(tone("user.account_inactive")).toBe("bad");
    expect(tone("plan.updated")).toBe("neutral");
  });

  it("reads stored values the way a person would", () => {
    const zone = "America/New_York";
    expect(formatFieldValue(null, zone)).toEqual({ text: "Not set", empty: true });
    expect(formatFieldValue(true, zone).text).toBe("Yes");
    expect(formatFieldValue("2026-11-11T23:11:09.686Z", zone).text).toBe("Wed, Nov 11, 2026 at 6:11 PM");
    // timestamp columns arrive without a zone and are UTC
    expect(formatFieldValue("2026-11-11T23:11:09", zone).text).toBe("Wed, Nov 11, 2026 at 6:11 PM");
    expect(formatFieldValue("2026-11-11", zone).text).toBe("Nov 11, 2026");
    expect(formatFieldValue(["member", "staff"], zone).text).toBe("member, staff");
    expect(formatFieldValue({ adultId: 4 }, zone).text).toBe('{"adultId":4}');
    expect(fieldLabel("resolvedAt")).toBe("Resolved");
    expect(fieldLabel("price_snapshot")).toBe("Price snapshot");
    expect(fieldLabel("primaryRole")).toBe("Primary role");
  });
});
