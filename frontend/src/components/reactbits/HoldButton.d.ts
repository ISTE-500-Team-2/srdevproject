import type { JSX, ReactNode } from "react";

export default function HoldButton(props: {
  children?: ReactNode;
  doneLabel?: ReactNode;
  icon?: ReactNode;
  doneIcon?: ReactNode;
  backgroundColor?: string;
  fillColor?: string;
  textColor?: string;
  fillTextColor?: string;
  size?: "sm" | "md" | "lg";
  radius?: number;
  holdTime?: number;
  resetAfter?: number;
  disabled?: boolean;
  onHold?: () => void;
  onTap?: () => void;
  className?: string;
}): JSX.Element;
