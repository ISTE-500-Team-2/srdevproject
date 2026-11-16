// A member's avatar on staff screens: their profile photo when they have one, otherwise whatever
// the screen already showed (usually initials).

import type { ReactNode } from "react";
import { useMemberPhoto } from "../lib/profilePhoto";

export function MemberPhoto({
  id,
  version,
  className,
  children,
}: {
  id: number | null | undefined;
  /** From the list or record the screen loaded; null or absent shows `children`. */
  version: string | null | undefined;
  /** The avatar's existing look: size, colours and shape. */
  className: string;
  /** Shown until the photo loads, and for members without one. */
  children: ReactNode;
}) {
  const photo = useMemberPhoto(id, version);
  return (
    <span className={photo ? `${className} has-photo` : className} aria-hidden="true">
      {photo ? <img className="avatar-photo" src={photo} alt="" /> : children}
    </span>
  );
}
