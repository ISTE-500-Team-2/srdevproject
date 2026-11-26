import { Phone } from "lucide-react";
import { useState } from "react";
import type { User, UserProfile } from "../../lib/contracts";
import { Detail, EditButton, Section, SectionForm, useReturnFocus } from "../profileSections";
import { Choice } from "./Choice";
import { ADDRESS, CONTACT_METHOD, CONTACT_TIME, METHODS, STATES, TIMES, text, type Save } from "./fields";
import { formatPhone, phoneToSave } from "./phone";

export function ContactSection({
  user,
  profile,
  save,
  readOnly,
  missing,
}: {
  user: User;
  profile: UserProfile | null;
  save: Save;
  readOnly: boolean;
  /** Shown instead of "Not added" while the profile is loading or after it failed to load. */
  missing?: string;
}) {
  const [editing, setEditing] = useState(false);
  const opener = useReturnFocus(editing);
  const address = profile?.address;
  const prefs = profile?.contactPreferences;
  const state = text(address, "State");
  const line = [
    text(address, "Street address"),
    text(address, "City"),
    [state, text(address, "Postal code")].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  const how = [text(prefs, CONTACT_METHOD), text(prefs, CONTACT_TIME).toLowerCase()].filter(Boolean).join(" · ");
  return (
    <Section
      id="contact"
      title="Contact"
      note="How the studio reaches you about bookings and access."
      Icon={Phone}
      editing={editing}
      action={
        !editing && profile && !readOnly ? <EditButton ref={opener} label="Edit contact" onClick={() => setEditing(true)} /> : null
      }
    >
      {editing ? (
        <SectionForm
          saveLabel="Save contact"
          onCancel={() => setEditing(false)}
          onSave={async (form) => {
            const field = (key: string) => String(form.get(key) ?? "").trim();
            await save({
              phone: phoneToSave(field("phone")),
              // Merge, so keys this page doesn't show (a gate code, an SMS
              // opt-in) survive the save.
              address: {
                ...profile?.address,
                ...Object.fromEntries(ADDRESS.map((key) => [key, field(key)])),
              },
              contactPreferences: {
                ...profile?.contactPreferences,
                [CONTACT_METHOD]: field(CONTACT_METHOD),
                [CONTACT_TIME]: field(CONTACT_TIME),
              },
            });
            setEditing(false);
          }}
        >
          <div className="account-fields">
            <label className="form-field form-field--wide">
              <span>Phone</span>
              <input
                name="phone"
                type="tel"
                inputMode="tel"
                required
                defaultValue={formatPhone(user.phone ?? "")}
                autoComplete="tel"
                placeholder="(410) 555-0182"
              />
            </label>
            <label className="form-field form-field--wide">
              <span>Street address</span>
              <input name="Street address" defaultValue={text(address, "Street address")} maxLength={200} autoComplete="street-address" />
            </label>
            <label className="form-field">
              <span>City</span>
              <input name="City" defaultValue={text(address, "City")} maxLength={200} autoComplete="address-level2" />
            </label>
            <div className="account-fields account-fields--pair">
              <label className="form-field">
                <span>State</span>
                <select name="State" defaultValue={state} autoComplete="address-level1">
                  <option value="">Choose</option>
                  {/* Keep an older free-text value selectable until it's changed. */}
                  {state && !STATES.includes(state) ? <option value={state}>{state}</option> : null}
                  {STATES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Postal code</span>
                <input
                  name="Postal code"
                  defaultValue={text(address, "Postal code")}
                  maxLength={10}
                  inputMode="numeric"
                  autoComplete="postal-code"
                />
              </label>
            </div>
            <Choice name={CONTACT_METHOD} label="Preferred contact" options={METHODS} value={text(prefs, CONTACT_METHOD)} />
            <Choice
              name={CONTACT_TIME}
              label="Best time"
              options={TIMES.map((value) => ({ value }))}
              value={text(prefs, CONTACT_TIME)}
            />
          </div>
        </SectionForm>
      ) : (
        <dl className="account-details">
          <Detail label="Phone">{user.phone ? formatPhone(user.phone) : ""}</Detail>
          <Detail label="Address" empty={missing}>
            {line}
          </Detail>
          <Detail label="Preferred contact" empty={missing}>
            {how}
          </Detail>
        </dl>
      )}
    </Section>
  );
}
