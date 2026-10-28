import type { JSX } from "react";

export default function SplitText(props: {
  text: string;
  tag?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span";
  className?: string;
  delay?: number;
  duration?: number;
  ease?: string;
  splitType?: "chars" | "words" | "lines";
  textAlign?: "left" | "center" | "right";
  trigger?: "view" | "load" | "hover" | "click";
  effect?: string;
  onLetterAnimationComplete?: () => void;
}): JSX.Element;
