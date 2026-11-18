// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { afterEach, expect, test } from 'vitest';
import { compileDarkTwins } from '../theme/darkCompiler';

const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
// The app's order: each stylesheet with its compiled dark twins, then dark.css last.
const sheets = [compileDarkTwins(read('components/monthCalendar.css'), 'monthCalendar.css'), read('theme/dark.css')];

/** [ids, classes/attributes/pseudo-classes, types]; :not() counts as its argument. */
function specificity(selector: string): number[] {
  const inner: number[][] = [];
  const rest = selector.replace(/:not\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, (_, arg: string) => {
    inner.push(specificity(arg));
    return ' ';
  });
  const own = [
    (rest.match(/#[\w-]+/g) ?? []).length,
    (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length,
    (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length,
  ];
  return inner.reduce((sum, s) => sum.map((n, i) => n + s[i]!), own);
}
const outranks = (a: number[], b: number[]) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i]! > b[i]!;
};

/** The winning value of each property for `element` while it is hovered, as the cascade picks it. */
function hoveredStyle(element: Element, props: string[]) {
  const won = new Map<string, { value: string; specificity: number[] }>();
  for (const css of sheets)
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent?.type === 'atrule') return;
      for (const selector of rule.selectors) {
        // The pointer is over the element, so :hover holds; jsdom can't hover, so match without it.
        if (!element.matches(selector.replace(/:hover/g, ''))) continue;
        const weight = specificity(selector);
        rule.walkDecls((decl) => {
          if (!props.includes(decl.prop)) return;
          const current = won.get(decl.prop);
          if (!current || !outranks(current.specificity, weight)) won.set(decl.prop, { value: decl.value, specificity: weight });
        });
      }
    });
  return Object.fromEntries(props.map((prop) => [prop, won.get(prop)?.value]));
}

function selectedDay(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.innerHTML = '<div class="studio-cal"><button type="button" class="studio-cal__day" aria-pressed="true">21</button></div>';
  return document.querySelector('.studio-cal__day')!;
}
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
});

test('in dark mode a hovered or tapped selected day keeps its dark text on the cream chip', () => {
  expect(hoveredStyle(selectedDay('dark'), ['background', 'color'])).toEqual({
    background: 'var(--dk-cream-chip)',
    color: 'var(--dk-copper-ink)',
  });
});

test('in light mode a hovered selected day stays white on ink', () => {
  expect(hoveredStyle(selectedDay('light'), ['background', 'color'])).toEqual({ background: 'var(--ink)', color: '#fff' });
});
