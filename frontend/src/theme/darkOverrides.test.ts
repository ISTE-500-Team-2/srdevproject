import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';
import { expect, test } from 'vitest';
import { contrast, mapColor, parseColor } from './darkCompiler';

// The dark compiler maps color literals by the property that holds them. Some colors it cannot
// reach or would map for the wrong role, so dark.css answers them by hand; these keep it doing so.
const src = join(__dirname, '..');
const DARK = join(src, 'theme', 'dark.css');

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) return stylesheets(file);
    return name.endsWith('.css') && file !== DARK ? [file] : [];
  });
}

/** Every declaration in dark.css, keyed by its selector without the dark root and with uniform quotes. */
const dark = new Map<string, Map<string, string>>();
postcss.parse(readFileSync(DARK, 'utf8')).walkDecls((decl) => {
  const rule = decl.parent as postcss.Rule;
  if (rule.type !== 'rule') return;
  for (const selector of rule.selectors) {
    const key = selector.replace(/^:root\[data-theme='dark'\]\s+/, '').replace(/'/g, '"');
    const props = dark.get(key) ?? new Map<string, string>();
    props.set(decl.prop, decl.value);
    dark.set(key, props);
  }
});

const ENCODED = /%23([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const encodedColors = (value: string) => [...value.matchAll(ENCODED)].map((m) => parseColor(`#${m[1]}`)!);
/** A white field as the compiler darkens it, the field behind these images. */
const darkField = mapColor(parseColor('#fff')!, 'surface');

// A URL-encoded color (%23rrggbb) inside an inline SVG is not a color literal to the compiler, so
// the image keeps its light-mode stroke on the darkened field.
const encodedImages = stylesheets(src).flatMap((file) => {
  const found: { file: string; selector: string }[] = [];
  postcss.parse(readFileSync(file, 'utf8')).walkDecls(/^background(-image)?$/, (decl) => {
    if (!decl.value.includes('data:image/svg+xml') || !encodedColors(decl.value).length) return;
    for (const selector of (decl.parent as postcss.Rule).selectors) found.push({ file: relative(src, file), selector });
  });
  return found;
});

test('the stylesheets still draw their dropdown arrows as inline SVG images', () => {
  expect(encodedImages.map(({ selector }) => selector).sort()).toEqual([
    '.class-field select',
    '.class-field--picker select',
    '.cw-field select',
    '.management-page .cw-select',
  ]);
});

test.each(encodedImages)('$file: $selector has a dark-mode image that stands out from its field', ({ selector }) => {
  const image = dark.get(selector)?.get('background-image') ?? '';
  const strokes = encodedColors(image);
  expect(strokes.length).toBeGreaterThan(0);
  // WCAG 1.4.11: the cue that a field is a dropdown needs 3:1 against the field.
  for (const stroke of strokes) expect(contrast(stroke, darkField)).toBeGreaterThanOrEqual(3);
});

test('the count on a selected class or desk chip stays readable on the cream dark-mode chip', () => {
  const chip = parseColor('#f2e8dd')!;
  for (const selector of ['.class-chip[aria-pressed="true"] em', '.desk-chip[aria-pressed="true"] em']) {
    const color = parseColor(dark.get(selector)?.get('color') ?? '');
    expect(color, selector).not.toBeNull();
    expect(contrast(color!, chip)).toBeGreaterThanOrEqual(4.5);
  }
  // The cream chip itself comes from this token.
  expect(dark.get(":root[data-theme=\"dark\"]")?.get('--dk-cream-chip')).toBe('#f2e8dd');
});
