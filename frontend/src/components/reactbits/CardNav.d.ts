import type { CSSProperties, ElementType, JSX, MouseEvent, ReactNode } from "react";

export interface CardNavLink {
  label: string;
  href?: string;
  ariaLabel?: string;
  [key: string]: unknown;
}

export interface CardNavItem {
  label: string;
  description?: string;
  bgColor?: string;
  textColor?: string;
  links?: CardNavLink[];
}

export default function CardNav(props: {
  logo?: ReactNode;
  logoAlt?: string;
  logoHref?: string;
  items?: CardNavItem[];
  cta?: { label: string; href?: string; onClick?: (event: MouseEvent) => void };
  theme?: "dark" | "light";
  surface?: "glass" | "solid";
  cardHeight?: number;
  maxWidth?: number;
  linkComponent?: ElementType;
  onLinkClick?: (link: CardNavLink, item: CardNavItem, event: MouseEvent) => void;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element;
