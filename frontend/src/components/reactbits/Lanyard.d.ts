import type { CSSProperties, JSX, RefObject } from "react";

export default function Lanyard(props: {
  frontImage?: string;
  backImage?: string;
  strapImage?: string;
  imageFit?: "cover" | "contain";
  cardColor?: string;
  orientation?: "portrait" | "landscape";
  finish?: "glossy" | "matte" | "holographic" | "metallic";
  /** Card corner rounding from 0 (nearly square) to 1 (fully rounded); clamped. Default 0.3. */
  cornerRadius?: number;
  size?: number;
  anchor?: "left" | "center" | "right";
  strapLength?: number;
  strapColor?: string;
  strapWidth?: number;
  metal?: "silver" | "gold" | "graphite";
  gravity?: number;
  damping?: number;
  /** Strap springiness from 0 to 1; clamped. Default 0.5. */
  elasticity?: number;
  breeze?: number;
  /** Tone-mapping exposure; lower it on dark pages so the white card doesn't glare. */
  exposure?: number;
  interactive?: boolean;
  intro?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * Where the card rests. When set, the lanyard fills its positioned parent
   * so the card can swing anywhere in that box, and pointer events pass
   * through to the content beneath except over the card.
   */
  home?: RefObject<HTMLElement | null>;
}): JSX.Element;
