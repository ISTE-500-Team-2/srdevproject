import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { expect, test } from 'vitest';
import { contrast, parseColor } from './darkCompiler';

// The dark compiler maps color literals but skips custom properties, so a color a
// stylesheet keeps in a local variable needs its own dark value in dark.css.
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/;
const DARK_ROOT = /^:root\[data-theme=['"]dark['"]\]\s+/;
const read = (file: string) => postcss.parse(readFileSync(join(__dirname, '..', file), 'utf8'));

function declarations(root: postcss.Root, keep: (rule: Rule) => boolean) {
  const found = new Map<string, Map<string, string>>();
  root.walkRules((rule) => {
    if (!keep(rule)) return;
    rule.walkDecls(/^--/, (decl) => {
      for (const selector of rule.selectors) {
        const props = found.get(selector) ?? new Map<string, string>();
        props.set(decl.prop, decl.value);
        found.set(selector, props);
      }
    });
  });
  return found;
}

const studios = declarations(read('pages/studios.css'), () => true);
const dark = declarations(read('theme/dark.css'), (rule) => rule.selectors.some((s) => DARK_ROOT.test(s)));
const darkRoot = declarations(read('theme/dark.css'), (rule) => rule.selector === ":root[data-theme='dark']").get(":root[data-theme='dark']")!;

const colorVariables = [...studios].flatMap(([selector, props]) =>
  [...props].filter(([, value]) => COLOR.test(value)).map(([prop]) => ({ selector, prop })),
);

test('studios.css still keeps its desk colors in local variables', () => {
  expect(colorVariables).toEqual([
    { selector: '.studio-desk', prop: '--desk-line' },
    { selector: '.studio-desk', prop: '--desk-muted' },
  ]);
});

test.each(colorVariables)('dark.css gives $selector $prop a dark value', ({ selector, prop }) => {
  expect(dark.get(`:root[data-theme='dark'] ${selector}`)?.get(prop)).toBeTruthy();
});

test('dark desk text keeps body-text contrast on the dark card', () => {
  const muted = dark.get(":root[data-theme='dark'] .studio-desk")?.get('--desk-muted');
  const resolved = muted?.replace(/^var\((--[\w-]+)\)$/, (_, name: string) => darkRoot.get(name) ?? '');
  expect(contrast(parseColor(resolved ?? '')!, parseColor(darkRoot.get('--dk-card')!)!)).toBeGreaterThanOrEqual(4.5);
});
