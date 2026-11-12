import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, test } from 'vitest';
import { compileDarkTwins, contrast, luminance, mapColor, mapValue, parseColor, roleOf } from './darkCompiler';

const CARD = parseColor('#251c16')!;
const PAGE = parseColor('#1a1410')!;

describe('compileDarkTwins', () => {
  test('adds a dark twin right after each rule and leaves the light rule as written', () => {
    const css = '.card { color: #24150e; padding: 4px; }\n.card:hover { background: #fff; }';
    const out = compileDarkTwins(css);
    const rules: string[] = [];
    postcss.parse(out).walkRules((r) => { rules.push(r.selector); });
    expect(rules).toEqual(['.card', ':root[data-theme="dark"] .card', '.card:hover', ':root[data-theme="dark"] .card:hover']);
    expect(out).toContain('.card { color: #24150e; padding: 4px; }');
    // Only color-bearing declarations are twinned.
    const twin = postcss.parse(out).nodes[1] as postcss.Rule;
    expect(twin.nodes.map((n) => (n as postcss.Declaration).prop)).toEqual(['color']);
  });

  test('copies variable-only declarations so the dark cascade keeps the light order', () => {
    const out = compileDarkTwins('.a { color: #24150e; }\n.a.b { color: var(--orange); }');
    expect(out).toContain(':root[data-theme="dark"] .a.b { color: var(--orange); }');
  });

  test('scopes :root, html and selector lists', () => {
    const out = compileDarkTwins(':root, html body, .x > .y { background: #fff; }');
    expect(out).toContain(':root[data-theme="dark"], html[data-theme="dark"] body, :root[data-theme="dark"] .x > .y');
  });

  test('keeps twins inside their media and container queries', () => {
    const out = compileDarkTwins('@media (max-width: 700px) { .a { color: #24150e; } }');
    const media = postcss.parse(out).first as postcss.AtRule;
    expect((media.nodes ?? []).map((n) => (n as postcss.Rule).selector)).toEqual(['.a', ':root[data-theme="dark"] .a']);
  });

  test('skips custom properties, keyframes and already-scoped rules', () => {
    const css = ':root { --ink: #24150e; }\n@keyframes glow { from { color: #fff; } }\n:root[data-theme="dark"] .x { color: #fff; }';
    expect(compileDarkTwins(css)).toBe(css);
  });
});

describe('color mapping', () => {
  test('dark ink becomes readable cream on dark cards and the page', () => {
    for (const ink of ['#24150e', '#685d57', '#8b7163', '#3d2a20', '#1f6b32', '#b73a2e', '#a86008', '#8a4b00', '#6b3d05', '#214d29']) {
      const mapped = mapColor(parseColor(ink)!, 'text');
      expect(contrast(mapped, CARD), ink).toBeGreaterThanOrEqual(4.5);
      expect(contrast(mapped, PAGE), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('bright brand hues and light text are left alone', () => {
    expect(mapValue('#f7961d', 'text')).toBe('#f7961d');
    expect(mapValue('#ffffff', 'text')).toBe('#ffffff');
  });

  test('white cards become dark surfaces, and off-white wells lift above them', () => {
    const card = mapColor(parseColor('#fffdfa')!, 'surface');
    const well = mapColor(parseColor('#f3ece7')!, 'surface');
    expect(contrast(card, parseColor('#ffffff')!)).toBeGreaterThan(12);
    // Relative luminance, not the hex strings' sort order.
    expect(luminance(well)).toBeGreaterThan(luminance(card));
  });

  test('status tints keep their hue as opaque dark fills', () => {
    const green = mapColor(parseColor('#e3f6e6')!, 'surface');
    expect(green.a).toBe(1);
    expect(green.g).toBeGreaterThan(green.r);
    expect(contrast(mapColor(parseColor('#1f6b32')!, 'text'), green)).toBeGreaterThanOrEqual(4.5);
  });

  test('shadows deepen and translucent hairlines turn warm', () => {
    expect(mapValue('0 5px 14px rgba(41, 20, 8, 0.08)', 'shadow')).toBe('0 5px 14px rgba(0, 0, 0, 0.208)');
    expect(mapValue('1px solid rgba(92, 73, 62, 0.16)', 'line')).toBe('1px solid rgba(255, 232, 210, 0.088)');
  });

  test('only color-bearing properties have a role', () => {
    expect(roleOf('border-top')).toBe('line');
    expect(roleOf('box-shadow')).toBe('shadow');
    expect(roleOf('--ink')).toBeNull();
    expect(roleOf('padding')).toBeNull();
  });
});

describe('the shipped stylesheets', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'theme') walk(path); }
      else if (name.endsWith('.css')) files.push(path);
    }
  };
  walk(join(__dirname, '..'));

  test('every app stylesheet compiles and every mapped text color is readable on dark cards', () => {
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const out = compileDarkTwins(readFileSync(file, 'utf8'), file);
      postcss.parse(out).walkRules((rule) => {
        if (!rule.selector.startsWith(':root[data-theme="dark"]')) return;
        rule.walkDecls('color', (decl) => {
          for (const literal of decl.value.match(/#[0-9a-f]{6}\b/gi) ?? []) {
            expect(contrast(parseColor(literal)!, CARD), `${file} ${rule.selector}`).toBeGreaterThanOrEqual(4.5);
          }
        });
      });
    }
  });
});
