import { UserRound } from "lucide-react";
import { useState } from "react";
import { ProfilePhotoSetting } from "../../components/ProfilePhotoSetting";
import type { User, UserProfile } from "../../lib/contracts";
import { Detail, EditButton, Section, SectionForm, useReturnFocus } from "../profileSections";
import type { Save } from "./fields";

export function ProfileSection({
  user,
  profile,
  save,
  notify,
  readOnly,
}: {
  user: User;
  profile: UserProfile | null;
  save: Save;
  notify: (message: string) => void;
  /** Staff with the member's account open: the server refuses these changes. */
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const opener = useReturnFocus(editing);
  return (
    <Section
      id="profile"
      title="Profile"
      note="Your name as staff and instructors see it."
      Icon={UserRound}
      editing={editing}
      action={
        !editing && profile && !readOnly ? <EditButton ref={opener} label="Edit profile" onClick={() => setEditing(true)} /> : null
      }
    >
      {editing ? (
        <SectionForm
          saveLabel="Save profile"
          onCancel={() => setEditing(false)}
          onSave={async (form) => {
            await save({
              firstName: String(form.get("firstName")),
              lastName: String(form.get("lastName")),
            });
            setEditing(false);
          }}
        >
          <div className="account-fields">
            <label className="form-field">
              <span>First name</span>
              <input name="firstName" defaultValue={user.firstName} required maxLength={50} autoComplete="given-name" />
            </label>
            <label className="form-field">
              <span>Last name</span>
              <input name="lastName" defaultValue={user.lastName} required maxLength={50} autoComplete="family-name" />
            </label>
          </div>
          <p className="account-hint">Change the email you sign in with under Sign-in.</p>
        </SectionForm>
      ) : (
        <>
          <ProfilePhotoSetting notify={notify} />
          <dl className="account-details">
            <Detail label="Name">
              {user.firstName} {user.lastName}
            </Detail>
            <Detail label="Email">{user.email}</Detail>
          </dl>
        </>
      )}
    </Section>
  );
}
