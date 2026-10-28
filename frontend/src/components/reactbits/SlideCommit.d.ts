import type { JSX, ReactNode } from "react";

export default function SlideCommit(props: {
  label?: string;
  doneLabel?: string;
  errorLabel?: string;
  onConfirm?: () => unknown;
  onDone?: () => void;
  onError?: (reason: unknown) => void;
  trackColor?: string;
  handleColor?: string;
  successColor?: string;
  dangerColor?: string;
  width?: number;
  height?: number;
  radius?: number;
  holdMs?: number;
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
}): JSX.Element;
