import type { ReactNode } from 'react';

interface SectionHeadingProps {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
}

export function SectionHeading({ title, eyebrow, action }: SectionHeadingProps) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </div>
      {action ? <div className="section-heading__action">{action}</div> : null}
    </div>
  );
}
