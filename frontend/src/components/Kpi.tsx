import { TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Headline number cards shared by Analytics and Reports (styles in analyticsDashboard.css). */
export function Delta({
  value,
  previous,
  format,
  unit,
}: {
  value: number | null;
  previous?: number;
  format: (n: number) => string;
  unit: string;
}) {
  if (value === null) return <span className="kpi__delta">No earlier data</span>;
  if (value === 0) return <span className="kpi__delta">Same as {unit}</span>;
  // "+$998 vs the previous period" says less than "$0 in the previous period".
  if (previous === 0)
    return <span className="kpi__delta">{format(0)} {unit.startsWith("the ") ? `in ${unit}` : unit}</span>;
  const Icon = value > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`kpi__delta kpi__delta--${value > 0 ? "up" : "down"}`}>
      <Icon aria-hidden="true" /> {value > 0 ? "+" : "−"}
      {format(Math.abs(value))} vs {unit}
    </span>
  );
}

export function Kpi({ label, Icon, value, children }: { label: string; Icon: LucideIcon; value: string; children: ReactNode }) {
  return (
    <article className="kpi">
      <span className="kpi__label">
        <Icon aria-hidden="true" /> {label}
      </span>
      <strong>{value}</strong>
      {children}
    </article>
  );
}
