import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type AtRule, type Declaration, type Root, type Rule } from 'postcss';
import { describe, expect, test } from 'vitest';
import { compileDarkTwins, contrast, parseColor } from './darkCompiler';

// Readability and focus rules that live in the stylesheets, checked against the theme tokens.
const SRC = join(__dirname, '..');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
const parse = (file: string) => postcss.parse(read(file));
const DARK_ROOT = ":root[data-theme='dark']";

function tokens(root: Root, selector: string) {
  const found = new Map<string, string>();
  root.walkRules((rule) => {
    if (rule.selector === selector) rule.walkDecls(/^--/, (decl) => void found.set(decl.prop, decl.value));
  });
  return found;
}

const light = tokens(parse('styles.css'), ':root');
const dark = tokens(parse('theme/dark.css'), DARK_ROOT);

/** Resolves var(--x) chains against a theme's tokens; returns the value unchanged when it isn't a variable. */
function resolve(value: string, theme: Map<string, string>): string {
  const match = value.trim().match(/^var\((--[\w-]+)\)$/);
  if (!match) return value.trim();
  const next = theme.get(match[1]!);
  expect(next, `${match[1]} is defined`).toBeTruthy();
  return resolve(next!, theme);
}

const color = (value: string, theme: Map<string, string>) => {
  const parsed = parseColor(resolve(value, theme));
  expect(parsed, `${value} resolves to a color`).not.toBeNull();
  return parsed!;
};

/** Declarations of the rules matching `selector`, optionally only inside an at-rule whose params match. */
function declarations(root: Root, selector: string, within?: RegExp) {
  const found = new Map<string, Declaration>();
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent?.type === 'atrule' ? (rule.parent as AtRule) : null;
    if (within ? !parent || !within.test(parent.params) : parent?.name === 'media') return;
    rule.walkDecls((decl) => void found.set(decl.prop, decl));
  });
  return found;
}

const REDUCED = /prefers-reduced-motion:\s*reduce/;

describe('focus', () => {
  test('the keyboard focus ring is at least 3:1 against the surfaces it sits on, in both themes', () => {
    const ring = declarations(parse('styles.css'), ':focus-visible').get('outline')?.value;
    expect(ring).toBe('3px solid var(--focus-ring)');
    for (const surface of ['--paper', '--surface-raised', '--surface-sunken'])
      expect(contrast(color('var(--focus-ring)', light), color(`var(${surface})`, light)), surface).toBeGreaterThanOrEqual(3);
    for (const surface of ['--paper', '--dk-card', '--surface-raised', '--surface-sunken'])
      expect(contrast(color('var(--focus-ring)', dark), color(`var(${surface})`, dark)), surface).toBeGreaterThanOrEqual(3);
  });

  test('espresso bands with buttons keep the orange ring, which is the one that stands out on them', () => {
    const styles = parse('styles.css');
    for (const band of ['.site-footer', '.membership-card', '.account-bar', '.account-help'])
      expect(declarations(styles, band).get('--focus-ring')?.value, band).toBe('var(--orange)');
    expect(contrast(color('var(--orange)', light), color('var(--espresso)', light))).toBeGreaterThanOrEqual(3);
  });

  test("the phone menu's ring reads on its bar, and on every tinted card in the link's own ink", () => {
    for (const theme of [light, dark])
      expect(contrast(color('var(--focus-ring)', theme), color('var(--nav-solid)', theme))).toBeGreaterThanOrEqual(3);
    const cardNav = parse('components/reactbits/CardNav.css');
    expect(declarations(cardNav, '.card-nav__menu:focus-visible').get('outline')?.value).toBe('2px solid var(--cn-ring)');
    expect(declarations(cardNav, '.card-nav__link:focus-visible').get('outline')?.value).toBe('2px solid currentColor');
    for (const theme of [light, dark])
      for (const card of ['--nav-card-1', '--nav-card-2', '--nav-card-3'])
        expect(contrast(color(`var(${card}-ink)`, theme), color(`var(${card})`, theme)), card).toBeGreaterThanOrEqual(3);
  });

  test('the sign-in fields drop their outline, so the underline shows focus in both themes', () => {
    const styles = parse('styles.css');
    expect(declarations(styles, '.form-field__control input').get('outline')?.value).toBe('0');
    const focused = declarations(styles, '.form-field__control:focus-within');
    expect(focused.get('border-bottom-color')?.value).toBe('var(--focus-ring)');
    expect(focused.get('box-shadow')?.value).toBe('0 1.5px 0 var(--focus-ring)');
    // In dark the twin carries it: it outranks dark.css's plain underline colour for .form-field__control.
    const twins = postcss.parse(compileDarkTwins(read('styles.css'), 'styles.css'));
    expect(declarations(twins, ':root[data-theme="dark"] .form-field__control:focus-within').get('border-bottom-color')?.value)
      .toBe('var(--focus-ring)');
  });

  test('the equipment filter and class search show focus in the ring token, not the faint orange', () => {
    const styles = parse('styles.css');
    expect(declarations(styles, '.select-control select').get('outline')?.value).toBe('0');
    expect(declarations(styles, '.select-control:has(select:focus-visible)').get('outline')?.value).toBe('3px solid var(--focus-ring)');
    const classes = parse('pages/classes.css');
    expect(declarations(classes, '.class-search input').get('outline')?.value).toBe('0');
    const search = declarations(classes, '.class-search:focus-within');
    expect(search.get('border-bottom-color')?.value).toBe('var(--focus-ring)');
    expect(search.get('box-shadow')?.value).toBe('0 1px 0 var(--focus-ring)');
  });
});

describe('dark mode', () => {
  test("sign-up's Continue button keeps its label readable", () => {
    const next = declarations(parse('theme/dark.css'), `${DARK_ROOT} .signup-stepper .stepper__button--next`);
    const ink = color(next.get('color')!.value, dark);
    const fill = resolve(next.get('background')!.value, dark);
    const stops = fill.match(/#[0-9a-f]{6}/gi) ?? [];
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) expect(contrast(ink, parseColor(stop)!), stop).toBeGreaterThanOrEqual(4.5);
  });

  test('the current password-reset step stands out on the dark card', () => {
    const active = declarations(parse('styles.css'), ".reset-progress__dot[data-status='active']").get('background')!.value;
    expect(contrast(color(active, dark), color('var(--dk-card)', dark))).toBeGreaterThanOrEqual(3);
    expect(contrast(color(active, light), color('var(--surface-raised)', light))).toBeGreaterThanOrEqual(3);
  });

  test('the phone menu and sign-up steps get a soft top-edge highlight instead of light mode white', () => {
    for (const token of ['--nav-highlight', '--stepper-theme-tile-highlight']) {
      expect(light.get(token), token).toBeTruthy();
      expect(color(`var(${token})`, dark).a, token).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('readability', () => {
  test("the member's check-in status is not faded", () => {
    expect(declarations(parse('styles.css'), '.check-in__status .status-mark__label').get('opacity')?.value).toBe('1');
  });
});

describe('motion', () => {
  test('the page entrance leaves no transform behind, so fixed buttons stay pinned to the screen', () => {
    const frames: Rule[] = [];
    parse('styles.css').walkAtRules('keyframes', (rule) => {
      if (rule.params === 'page-enter') rule.walkRules((frame) => void frames.push(frame));
    });
    const last = frames.at(-1)!;
    expect(last.selector).toBe('to');
    const transforms: string[] = [];
    last.walkDecls('transform', (decl) => void transforms.push(decl.value));
    expect(transforms).toEqual(['none']);
  });

  test('a looping reduced-motion animation outlasts the global reset that stops all motion', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.css')) files.push(path);
      }
    };
    walk(SRC);
    const kept: string[] = [];
    for (const file of files) {
      postcss.parse(readFileSync(file, 'utf8')).walkAtRules('media', (media) => {
        if (!REDUCED.test(media.params)) return;
        media.walkDecls((decl) => {
          const loops = /\binfinite\b/.test(decl.value) || decl.prop === 'animation-duration' && !/^0(\.01)?m?s$/.test(decl.value);
          if (!loops || decl.parent?.type !== 'rule' || (decl.parent as Rule).selector.includes('*')) return;
          kept.push((decl.parent as Rule).selector);
          expect(decl.important, `${file}: ${(decl.parent as Rule).selector} ${decl.prop}`).toBe(true);
        });
      });
    }
    expect(kept).toEqual(expect.arrayContaining(['.spin', '.status-mark[data-indeterminate] .status-mark__ring']));
    expect(declarations(parse('styles.css'), '.spin', REDUCED).get('animation-iteration-count')?.important).toBe(true);
  });

  test('with reduced motion the hold fill follows the hold, not a transition the global reset cuts short', () => {
    const fill = declarations(parse('components/reactbits/HoldButton.css'), '.hold-button__fill', REDUCED);
    expect(fill.get('opacity')?.value).toBe('var(--hb-p)');
    const transitions: string[] = [];
    parse('components/reactbits/HoldButton.css').walkAtRules('media', (media) => {
      if (!REDUCED.test(media.params)) return;
      media.walkRules((rule) => {
        if (rule.selector.includes('hold-button__fill')) rule.walkDecls(/^transition/, (decl) => void transitions.push(rule.selector));
      });
    });
    expect(transitions).toEqual([]);
  });
});
