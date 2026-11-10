/**
 * Dark theme compiler.
 *
 * For every rule that sets a color-bearing property, emits a twin rule scoped to
 * `:root[data-theme="dark"]` directly after it, with each color literal mapped to
 * its dark-mode counterpart by role (text, surface, line or shadow). Declarations
 * that use only variables or keywords are copied unchanged so the dark cascade
 * keeps the light cascade's order: a twin always outranks its own light rule
 * (+0,2,0 specificity) and loses to any later twin exactly where the light rules
 * would.
 *
 * Light mode is untouched: the source rules are never edited. Theme variables and
 * hand-tuned components live in `dark.css`, which this compiler skips.
 */
import postcss, { type AtRule, type Declaration, type Root, type Rule } from 'postcss';

type Role = 'text' | 'surface' | 'line' | 'shadow' | 'keep';
type Rgba = { r: number; g: number; b: number; a: number };

const DARK_ROOT = ':root[data-theme="dark"]';
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

const ROLES: Array<[RegExp, Role]> = [
  [/^(color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color|outline|outline-color)$/, 'text'],
  [/^(background|background-color|background-image)$/, 'surface'],
  [/^(border|border-(top|right|bottom|left|block|inline)(-(start|end))?|border(-(top|right|bottom|left))?-color|column-rule(-color)?)$/, 'line'],
  [/^(box-shadow|text-shadow|filter)$/, 'shadow'],
  [/^(accent-color)$/, 'keep'],
];

export function roleOf(prop: string): Role | null {
  if (prop.startsWith('--')) return null;
  for (const [pattern, role] of ROLES) if (pattern.test(prop)) return role;
  return null;
}

// ---------- color math (sRGB <-> OKLCH) ----------
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklch({ r, g, b }: Rgba) {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function fromOklch(L: number, C: number, h: number, a: number): Rgba {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(v))) * 255));
  return { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a };
}

export function parseColor(text: string): Rgba | null {
  const t = text.trim().toLowerCase();
  if (t === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (t === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  const m = t.match(/^rgba?\(([^)]*)\)$/);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
}

export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 0.999) return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

const luminance = ({ r, g, b }: Rgba) => 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
export const contrast = (x: Rgba, y: Rgba) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a! + 0.05) / (b! + 0.05);
};

/** Dark card surface; generated text is checked against it. */
const CARD: Rgba = { r: 0x25, g: 0x1c, b: 0x16, a: 1 };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const warm = (a: number): Rgba => ({ r: 255, g: 240, b: 225, a });

/** Maps one light-mode color to its dark-mode counterpart for a role. */
export function mapColor(input: Rgba, role: Role): Rgba {
  if (role === 'keep') return input;
  const { L, C, h } = toOklch(input);
  const a = input.a;
  const vivid = C >= 0.08;

  if (role === 'text') {
    if (L >= 0.8 || (vivid && L >= 0.62)) return input; // already light, or a bright brand/status hue
    let out = fromOklch(clamp(0.96 - (L - 0.18) * 0.55, 0.7, 0.95), Math.min(C * 0.9, 0.16), h, a);
    for (let next = 0.72; contrast(out, CARD) < 4.5 && next <= 0.96; next += 0.02) out = fromOklch(next, Math.min(C * 0.9, 0.16), h, a);
    return out;
  }

  if (role === 'shadow') {
    if (vivid) return input;
    return L > 0.6 ? warm(Math.min(0.08, a * 0.4)) : { r: 0, g: 0, b: 0, a: Math.min(0.6, a * 2.6) };
  }

  if (role === 'line') {
    if (vivid) return input;
    if (L > 0.92 && a < 0.6) return input; // white hairlines already sit on dark fills
    if (L < 0.5 && a < 0.6) return { r: 255, g: 232, b: 210, a: +(a * 0.55).toFixed(3) };
    if (L < 0.5) return mapColor({ ...input, a: 1 }, 'text'); // ink underlines become cream
    return fromOklch(clamp(0.33 + (0.75 - L), 0.3, 0.55), Math.min(C * 0.8, 0.04), h, a);
  }

  // surface
  if (L > 0.85) {
    if (C >= 0.02 && a >= 0.6) return fromOklch(0.27, Math.min(0.06, C * 1.4), h, 1); // status and accent tints
    if (a < 0.6) return warm(+(a * 0.08).toFixed(3)); // light washes over paper
    return fromOklch(0.255 + Math.abs(L - 0.99) * 0.45, Math.min(C * 1.2, 0.03), h, 1); // white cards, off-white wells lift
  }
  if (L > 0.45) return vivid ? input : fromOklch(clamp(0.3 + (0.85 - L) * 0.4, 0.3, 0.45), Math.min(C, 0.03), h, a);
  if (a < 0.3) return warm(+(a * 0.9).toFixed(3)); // dark hover tints lighten instead
  if (a < 1) return { r: 5, g: 3, b: 2, a: Math.min(0.8, a + 0.1) }; // scrims
  return fromOklch(Math.max(L, 0.3), C, h, 1); // espresso fills lift off the page
}

export function mapValue(value: string, role: Role): string {
  return value.replace(COLOR, (literal) => {
    const parsed = parseColor(literal);
    return parsed ? formatColor(mapColor(parsed, role)) : literal;
  });
}

function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (s.startsWith(':root')) return DARK_ROOT + s.slice(':root'.length);
  if (/^html\b/.test(s)) return 'html[data-theme="dark"]' + s.slice(4);
  return `${DARK_ROOT} ${s}`;
}

function insideKeyframes(rule: Rule) {
  for (let p = rule.parent; p; p = (p as AtRule).parent) {
    if (p.type === 'atrule' && /keyframes$/i.test((p as AtRule).name)) return true;
    if (p.type === 'root') break;
  }
  return false;
}

/** Appends a dark twin after every rule that sets a color-bearing property. */
export function compileDarkTwins(css: string, from?: string): string {
  const root: Root = postcss.parse(css, { from });
  root.walkRules((rule) => {
    if (insideKeyframes(rule) || rule.selector.includes(DARK_ROOT) || rule.selector.includes('[data-theme')) return;
    const decls = rule.nodes.filter((n): n is Declaration => n.type === 'decl' && roleOf(n.prop) !== null);
    if (!decls.length) return;
    const twin = postcss.rule({ selectors: rule.selectors.map(scopeSelector) });
    for (const d of decls) twin.append(d.clone({ value: mapValue(d.value, roleOf(d.prop)!), raws: {} }));
    rule.after(twin);
  });
  return root.toString();
}
