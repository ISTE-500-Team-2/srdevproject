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

// Staff pages that keep their dividers and secondary text in local variables.
const STYLESHEETS = ['pages/studios.css', 'pages/admin/today.css', 'pages/plans.css'];
const dark = declarations(read('theme/dark.css'), (rule) => rule.selectors.some((s) => DARK_ROOT.test(s)));
const darkRoot = declarations(read('theme/dark.css'), (rule) => rule.selector === ":root[data-theme='dark']").get(":root[data-theme='dark']")!;

const colorVariables = STYLESHEETS.flatMap((file) =>
  [...declarations(read(file), () => true)].flatMap(([selector, props]) =>
    [...props].filter(([, value]) => COLOR.test(value)).map(([prop]) => ({ selector, prop })),
  ),
);

test('the staff desk, Today and Plans pages still keep these colors in local variables', () => {
  expect(colorVariables).toEqual([
    { selector: '.studio-desk', prop: '--desk-line' },
    { selector: '.studio-desk', prop: '--desk-muted' },
    { selector: '.today', prop: '--today-line' },
    { selector: '.today', prop: '--today-line-strong' },
    { selector: '.today', prop: '--today-muted' },
    { selector: '.plans', prop: '--plans-line' },
    { selector: '.plans', prop: '--plans-muted' },
  ]);
});

test.each(colorVariables)('dark.css gives $selector $prop a dark value', ({ selector, prop }) => {
  expect(dark.get(`:root[data-theme='dark'] ${selector}`)?.get(prop)).toBeTruthy();
});

test.each(colorVariables.filter(({ prop }) => prop.endsWith('-muted')))(
  'dark $selector $prop text keeps body-text contrast on the dark card',
  ({ selector, prop }) => {
    const muted = dark.get(`:root[data-theme='dark'] ${selector}`)?.get(prop);
    const resolved = muted?.replace(/^var\((--[\w-]+)\)$/, (_, name: string) => darkRoot.get(name) ?? '');
    expect(contrast(parseColor(resolved ?? '')!, parseColor(darkRoot.get('--dk-card')!)!)).toBeGreaterThanOrEqual(4.5);
  },
);
