import type { CSSProperties, ForwardRefExoticComponent, ReactNode, RefAttributes } from "react";

export interface ClickSparkHandle {
  spark: (x?: number, y?: number) => void;
}

declare const ClickSpark: ForwardRefExoticComponent<
  {
    sparkColor?: string | string[];
    sparkSize?: number;
    sparkRadius?: number;
    sparkCount?: number;
    sparkWidth?: number;
    duration?: number;
    easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";
    extraScale?: number;
    shape?: "line" | "streak" | "dot" | "star";
    randomness?: number;
    gravity?: number;
    spread?: number;
    direction?: number;
    glow?: number;
    ring?: boolean;
    layer?: "front" | "back";
    disabled?: boolean;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
  } & RefAttributes<ClickSparkHandle>
>;

export default ClickSpark;
