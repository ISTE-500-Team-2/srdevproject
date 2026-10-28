import type { JSX } from "react";

export default function SpringCheck(props: {
  label?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  color?: string;
  fillColor?: string;
  checkColor?: string;
  boxSize?: number;
  boxRadius?: number;
  fontSize?: number;
  bounce?: number;
  strikeLag?: number;
  doneOpacity?: number;
  strike?: "left" | "center" | "right" | "none";
  ariaLabel?: string;
  className?: string;
}): JSX.Element;
