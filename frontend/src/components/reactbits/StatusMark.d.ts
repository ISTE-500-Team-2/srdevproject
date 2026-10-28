import type { CSSProperties, JSX } from "react";

export default function StatusMark(props: {
  status?: "pending" | "running" | "done" | "failed" | "cancelled";
  progress?: number;
  label?: string;
  color?: string;
  doneColor?: string;
  errorColor?: string;
  size?: number;
  strokeWidth?: number;
  strike?: boolean;
  className?: string;
  style?: CSSProperties;
}): JSX.Element;
