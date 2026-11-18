// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type AtRule } from 'postcss';
import { afterEach, describe, expect, test } from 'vitest';
import { compileDarkTwins, contrast, parseColor } from './darkCompiler';

/*
 * The shipped cascade, resolved for elements built in jsdom: every app stylesheet in the order main.tsx loads it,
 * each followed by its generated dark twins, then dark.css. Most dark-mode slips are cascade slips (a twin or a
 * designed rule winning by specificity or order where it should not), so these tests ask what a page really gets.
 */
const src = join(__dirname, '..');
const pageStyles = [...readFileSync(join(src, 'pageStyles.ts'), 'utf8').matchAll(/import '\.\/([^']+\.css)'/g)].map((m) => m[1]!);
const SHEETS = [...pageStyles, 'styles.css', 'tables.css', 'theme/dark.css'];

type Viewport = { width: number; height: number };
type Declared = { selector: string; specificity: number; order: number; media: string[]; value: string; important: boolean };

const DESKTOP: Viewport = { width: 1280, height: 900 };
const PHONE: Viewport = { width: 390, height: 800 };
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/;

/** Specificity as one comparable number: ids, then classes, attributes and pseudo-classes, then types. */
function specificity(selector: string): number {
  const name = (from: number) => /^[\w-]*/.exec(selector.slice(from))![0];
  let score = 0;
  for (let i = 0; i < selector.length; ) {
    const ch = selector[i]!;
    if (ch === '#' || ch === '.') {
      score += ch === '#' ? 1e6 : 1e3;
      i += 1 + name(i + 1).length;
    } else if (ch === '[') {
      score += 1e3;
      i = selector.indexOf(']', i) + 1;
    } else if (ch === ':') {
      const pseudoElement = selector[i + 1] === ':';
      const start = i + (pseudoElement ? 2 : 1);
      const fn = name(start);
      i = start + fn.length;
      let args = '';
      if (selector[i] === '(') {
        let depth = 0;
        let end = i;
        for (; end < selector.length; end++) {
          if (selector[end] === '(') depth++;
          else if (selector[end] === ')' && --depth === 0) break;
        }
        args = selector.slice(i + 1, end);
        i = end + 1;
      }
      if (pseudoElement) score += 1;
      else if (/^(not|is|has)$/.test(fn)) score += Math.max(0, ...postcss.list.comma(args).map(specificity));
      else if (fn !== 'where') score += 1e3;
    } else if (/[a-zA-Z]/.test(ch)) {
      score += 1;
      i += name(i).length;
    } else i++;
  }
  return score;
}

const declared = new Map<string, Declared[]>();
let order = 0;
for (const sheet of SHEETS) {
  const file = join(src, sheet);
  const css = readFileSync(file, 'utf8');
  postcss.parse(sheet.startsWith('theme/') ? css : compileDarkTwins(css, file)).walkRules((rule) => {
    const media: string[] = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = (p as AtRule).parent) {
      const at = p as AtRule;
      if (at.name === 'media') media.push(at.params);
      else if (at.name !== 'supports') return; // keyframes and container queries are out of scope
    }
    rule.each((node) => {
      if (node.type !== 'decl') return;
      order++;
      for (const selector of rule.selectors) {
        const list = declared.get(node.prop) ?? [];
        list.push({ selector, specificity: specificity(selector), order, media, value: node.value, important: node.important });
        declared.set(node.prop, list);
      }
    });
  });
}

/** Width and height queries only; hover, reduced motion, contrast and print never match here. */
const mediaMatches = (query: string, view: Viewport) =>
  postcss.list.comma(query).some((part) => {
    const features = [...part.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!);
    if (!features.length) return /^(all|screen)$/i.test(part.trim());
    if (/^\s*not\b/i.test(part)) return false;
    return features.every((feature) => {
      const m = /^\s*(min|max)-(width|height)\s*:\s*([\d.]+)px\s*$/.exec(feature);
      if (!m) return false;
      const size = view[m[2] as keyof Viewport];
      return m[1] === 'min' ? size >= Number(m[3]) : size <= Number(m[3]);
    });
  });

const matches = (el: Element, selector: string) => {
  if (selector.includes('::')) return false;
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
};

const rank = (a: Declared, b: Declared) => Number(a.important) - Number(b.important) || a.specificity - b.specificity || a.order - b.order;

/** The cascaded (unresolved) value of the first of `props` to win on `el`, or undefined when nothing sets them. */
function cascaded(el: Element, props: string[], view: Viewport): string | undefined {
  let best: Declared | undefined;
  for (const prop of props)
    for (const d of declared.get(prop) ?? [])
      if (d.media.every((q) => mediaMatches(q, view)) && matches(el, d.selector) && (!best || rank(d, best) > 0)) best = d;
  const inline = props.map((prop) => (el as HTMLElement).style?.getPropertyValue(prop)).find(Boolean);
  return inline && !best?.important ? inline : best?.value;
}

/** Substitutes var() references with the custom property values `el` inherits. */
function resolve(el: Element, value: string, view: Viewport): string {
  const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/;
  let out = value;
  for (let m = VAR.exec(out), guard = 0; m && guard < 50; m = VAR.exec(out), guard++) {
    out = out.replace(m[0], inherited(el, m[1]!, view) ?? m[2]?.trim() ?? '');
  }
  return out;
}

function inherited(el: Element, prop: string, view: Viewport): string | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = cascaded(node, [prop], view);
    if (value !== undefined) return resolve(node, value, view);
  }
  return undefined;
}

const computed = (el: Element, props: string[], view = DESKTOP) => {
  const value = cascaded(el, props, view);
  return value === undefined ? undefined : resolve(el, value, view);
};
const colorIn = (value: string | undefined) => {
  const literal = value?.match(COLOR)?.[0];
  return literal ? parseColor(literal) : null;
};
const textColor = (el: Element, view = DESKTOP) => colorIn(inherited(el, 'color', view))!;

/** The solid colour behind `el`: its own and its ancestors' fills, composited down to the first opaque one. */
function backdrop(el: Element, view = DESKTOP) {
  const layers: NonNullable<ReturnType<typeof parseColor>>[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = computed(node, ['background', 'background-color'], view);
    const color = value && !/gradient|url\(/.test(value) ? colorIn(value) : null;
    if (!color) continue;
    layers.unshift(color);
    if (color.a >= 0.999) break;
  }
  const mix = (over: number, under: number, a: number) => over * a + under * (1 - a);
  return layers.reduce((under, over) => ({
    r: mix(over.r, under.r, over.a),
    g: mix(over.g, under.g, over.a),
    b: mix(over.b, under.b, over.a),
    a: 1,
  }));
}

const build = (html: string, theme: 'light' | 'dark') => {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  document.body.innerHTML = html;
};
const $ = (selector: string) => document.querySelector(selector)!;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '';
});

describe('the resolver', () => {
  test('ranks selectors the way browsers do', () => {
    expect(specificity(':root[data-theme="dark"] .modal-card.modal-card--navigation')).toBe(4000);
    expect(specificity('.a:not(.b .c) > p::before')).toBe(3002);
    expect(specificity(':where(.a) .b:hover')).toBe(2000);
  });
});

describe('small labels keep body-text contrast in light mode', () => {
  test.each([
    ['staff sidebar group heading', '<aside class="admin-side"><nav class="admin-nav"><div class="admin-nav__group"><span class="admin-nav__group-label">People</span></div></nav></aside>', '.admin-nav__group-label'],
    ['staff sidebar role', '<aside class="admin-side"><div class="admin-side__me"><span class="admin-side__who"><strong>Sam</strong><span>Staff</span></span></div></aside>', '.admin-side__who span'],
    ['account picker heading', '<div class="modal-card"><div class="account-picker"><p class="account-picker__label">Recent</p></div></div>', '.account-picker__label'],
    ['account picker email', '<div class="modal-card"><button class="account-picker__row"><span class="account-picker__who"><strong>Ana</strong><span>ana@example.invalid</span></span></button></div>', '.account-picker__who span'],
    ['account snapshot detail', '<section class="panel account-snapshot"><dl class="account-snapshot__rows"><div><dt>Plan</dt><dd><strong>Monthly</strong><span>Renews soon</span></dd></div></dl></section>', 'dd span'],
    ['past booking on Today', '<section class="today-panel"><div class="today-track"><span class="today-block today-block--past">Lathe</span></div></section>', '.today-block--past'],
    ['cancelled class title', '<ul class="class-list"><li class="class-row class-row--cancelled"><div class="class-row__info"><h3>Intro to welding</h3></div></li></ul>', 'h3'],
    ['cancelled class time', '<ul class="class-list"><li class="class-row class-row--cancelled"><div class="class-row__info"><p class="class-meta"><span>9:00 to 11:00</span></p></div></li></ul>', '.class-meta span'],
  ])('%s', (_name, html, selector) => {
    build(html, 'light');
    const el = $(selector);
    expect(contrast(textColor(el), backdrop(el))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('dark mode', () => {
  test('the staff phone menu is one colour, the same as the desktop sidebar', () => {
    build(
      '<aside class="admin-side"></aside>' +
        '<div class="modal-backdrop modal-backdrop--navigation"><div class="modal-card modal-card--navigation">' +
        '<div class="modal-card__header"><h2>Menu</h2></div><div class="modal-card__body"></div></div></div>',
      'dark',
    );
    const sidebar = computed($('.admin-side'), ['background', 'background-color']);
    expect(sidebar).toBe('#120d0a');
    expect(computed($('.modal-card--navigation'), ['background', 'background-color'])).toBe(sidebar);
    expect(computed($('.modal-card--navigation .modal-card__header'), ['background', 'background-color'])).toBe(sidebar);
  });

  test('the sidebar stripe is drawn only where the sidebar shows', () => {
    build('<div class="admin-shell"><aside class="admin-side"></aside><main class="admin-main"></main></div>', 'dark');
    expect(computed($('.admin-shell'), ['background', 'background-color'], DESKTOP)).toMatch(/^linear-gradient\(to right, #120d0a 251px/);
    expect(computed($('.admin-shell'), ['background', 'background-color'], PHONE)).toBe('none');
  });

  test('the Staff role pill is readable', () => {
    build('<div class="account-bar"><p class="account-bar__line"><span class="account-role account-role--staff">Staff</span></p></div>', 'dark');
    const pill = $('.account-role--staff');
    expect(contrast(textColor(pill), backdrop(pill))).toBeGreaterThanOrEqual(4.5);
  });

  test('member avatars keep their colour coding, and the staff member keeps their own look', () => {
    build(
      [0, 1, 2, 3, 4].map((n) => `<span class="admin-avatar admin-avatar--${n}">A</span>`).join('') +
        '<span class="admin-avatar admin-avatar--self">S</span>',
      'dark',
    );
    const fills = [0, 1, 2, 3, 4].map((n) => computed($(`.admin-avatar--${n}`), ['background', 'background-color']));
    expect(new Set(fills).size).toBe(5);
    expect(computed($('.admin-avatar--self'), ['background', 'background-color'])).toBe('#3a1d0b');
  });
});

test.each(['light', 'dark'] as const)('in %s mode the hold-to-confirm focus ring stands out from its dialog', (theme) => {
  build('<div class="modal-card"><button class="hold-button site-hold-button" type="button">Hold to cancel</button></div>', theme);
  const button = $('.hold-button') as HTMLButtonElement;
  // As every caller passes them (CancelClassDialog, ProfilePage and the rest).
  button.style.setProperty('--hb-bg', 'var(--hold-danger-bg)');
  button.style.setProperty('--hb-fill', 'var(--hold-danger)');
  button.style.setProperty('--hb-text', 'var(--hold-danger-text)');
  button.focus();
  const ring = colorIn(computed(button, ['outline', 'outline-color']))!;
  expect(contrast(ring, backdrop($('.modal-card')))).toBeGreaterThanOrEqual(3);
});
