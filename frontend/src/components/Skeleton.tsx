import type { CSSProperties, ReactNode } from 'react';

/**
 * A grey block the size of content that is still loading. Screen readers skip it:
 * put it inside a `SkeletonGroup`, which says once what is loading.
 * It fades in after a short delay (styles.css), so quick loads never flash grey.
 */
export function Skeleton({ width, height, round = false, className = '' }: {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  /** Pill ends, for status pills and buttons. */
  round?: boolean;
  className?: string;
}) {
  // data-loading: the workspace holds its height while a page shows these (steadyHeight).
  return <span aria-hidden="true" data-loading="" className={`skeleton${round ? ' skeleton--round' : ''}${className ? ` ${className}` : ''}`} style={{ width, height }} />;
}

/** Holds a loading area's placeholders and announces `label` once to screen readers. */
export function SkeletonGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <div className={className} role="status" aria-label={label} data-loading="">
    <span className="sr-only">{label}</span>
    {children}
  </div>;
}
