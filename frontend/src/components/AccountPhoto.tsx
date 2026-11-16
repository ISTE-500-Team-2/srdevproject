// The avatar for the account this session shows: its profile photo when it has one, otherwise its
// initials. `/me/photo` is that account's photo, so anyone else (such as the staff member while a
// member's account is open) gets initials until the session shows their account again.

import { useAuth } from "../context/AuthContext";
import type { User } from "../lib/contracts";
import { useProfilePhoto } from "../lib/profilePhoto";
import { initials } from "./admin/people";

export function AccountPhoto({
  person,
  className,
}: {
  person: Pick<User, "id" | "firstName" | "lastName" | "photoVersion">;
  /** The avatar's existing look: size, colours and shape. */
  className: string;
}) {
  const { user } = useAuth();
  const shown = user?.id === person.id;
  const photo = useProfilePhoto(shown ? person.photoVersion : null, user?.id);
  return (
    <span className={photo ? `${className} has-photo` : className} aria-hidden="true">
      {photo ? <img className="avatar-photo" src={photo} alt="" /> : initials(person.firstName, person.lastName)}
    </span>
  );
}
