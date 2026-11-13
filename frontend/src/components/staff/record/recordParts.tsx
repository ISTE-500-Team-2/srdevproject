import {
  CalendarClock,
  Check,
  FilePenLine,
  GraduationCap,
  Info,
  LogIn,
  LogOut,
  Nfc,
  Pause,
  PenLine,
  Receipt,
  ShieldCheck,
  UserRoundCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { shortDate } from "../../../lib/display";
import type { DialogState } from "./RecordDialogs";

/** Opens one of the record's dialogs. */
export type OpenDialog = (d: DialogState) => void;

export const ROW_ICONS: Record<string, LucideIcon> = {
  login: LogIn,
  logout: LogOut,
  x: X,
  check: Check,
  nfc: Nfc,
  receipt: Receipt,
  pause: Pause,
  user: UserRoundCheck,
  shield: ShieldCheck,
  pen: PenLine,
  cap: GraduationCap,
  waiver: FilePenLine,
  calendar: CalendarClock,
};

/** A date without its weekday, as the record's rows show it. */
export const day = (value: string) => shortDate(value).replace(/^\w+, /, "");

/** One line in a record section: an icon, a title with optional detail, and whatever sits at its end. */
export function Row({ icon, tone = "neutral", title, detail, end }: { icon: string; tone?: "ok" | "alert" | "neutral"; title: ReactNode; detail?: string; end?: ReactNode }) {
  const Icon = ROW_ICONS[icon] ?? Info;
  return (
    <div className="mr-row">
      <span className={`today-todo-icon${tone === "alert" ? " today-todo-icon--alert" : tone === "ok" ? " mr-icon--ok" : ""}`}>
        <Icon aria-hidden="true" />
      </span>
      <span className="mr-row__text">
        <span className="mr-row__title">{title}</span>
        {detail ? <span className="mr-row__detail">{detail}</span> : null}
      </span>
      {end ? <span className="mr-row__end">{end}</span> : null}
    </div>
  );
}
