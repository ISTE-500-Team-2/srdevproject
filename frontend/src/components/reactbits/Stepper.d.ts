import type { ButtonHTMLAttributes, CSSProperties, JSX, ReactNode } from "react";

export function Step(props: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
}): JSX.Element;

export default function Stepper(props: {
  children?: ReactNode;
  step?: number;
  initialStep?: number;
  onStepChange?: (step: number) => void;
  onFinalStepCompleted?: () => void;
  indicator?: "numbers" | "dots" | "bars";
  orientation?: "horizontal" | "vertical";
  transition?: "slide" | "fade" | "none";
  linear?: boolean;
  disableStepIndicators?: boolean;
  renderStepIndicator?: (args: {
    step: number;
    currentStep: number;
    onStepClick: (step: number) => void;
  }) => ReactNode;
  showFooter?: boolean;
  backButtonText?: string;
  nextButtonText?: string;
  completeButtonText?: string;
  backButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  nextButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  completedContent?: ReactNode;
  theme?: "dark" | "light";
  accentColor?: string;
  frame?: boolean;
  radius?: number;
  width?: number | string;
  className?: string;
  stepCircleContainerClassName?: string;
  stepContainerClassName?: string;
  contentClassName?: string;
  footerClassName?: string;
  style?: CSSProperties;
}): JSX.Element;
