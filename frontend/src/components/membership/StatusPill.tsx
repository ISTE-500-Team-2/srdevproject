import type { ReactNode } from "react";
import type { StatusTone } from "../../lib/display";

export function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return <span className={`plan-pill plan-pill--${tone}`}>{children}</span>;
}
