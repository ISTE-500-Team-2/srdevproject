import type { CSSProperties, JSX } from "react";

export default function Lanyard(props: {
  frontImage?: string;
  backImage?: string;
  strapImage?: string;
  imageFit?: "cover" | "contain";
  cardColor?: string;
  orientation?: "portrait" | "landscape";
  finish?: "glossy" | "matte" | "holographic" | "metallic";
  size?: number;
  anchor?: "left" | "center" | "right";
  strapLength?: number;
  strapColor?: string;
  strapWidth?: number;
  metal?: "silver" | "gold" | "graphite";
  gravity?: number;
  damping?: number;
  breeze?: number;
  interactive?: boolean;
  intro?: boolean;
  className?: string;
  style?: CSSProperties;
}): JSX.Element;
