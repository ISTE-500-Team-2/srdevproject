import { useLayoutEffect, useRef, useState } from "react";
import SlideCommit from "./reactbits/SlideCommit";

/**
 * React Bits SlideCommit in the site's colours. The component works in fixed
 * pixels, so this measures the space it sits in and passes that width down.
 */
export function SiteSlideCommit({
  label,
  doneLabel,
  errorLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  doneLabel: string;
  errorLabel: string;
  disabled?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="site-slide-commit" ref={box}>
      {width ? (
        <SlideCommit
          label={label}
          doneLabel={doneLabel}
          errorLabel={errorLabel}
          disabled={disabled}
          onConfirm={onConfirm}
          width={width}
          height={52}
          radius={10}
          trackColor="#efe8e2"
          handleColor="#3a1b08"
          successColor="#1f6b32"
          dangerColor="#b73a2e"
        />
      ) : null}
    </div>
  );
}
