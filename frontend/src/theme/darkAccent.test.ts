import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { expect, test } from 'vitest';

// The dark compiler keeps accent-color as it is, so a checkbox with a dark brown
// accent would show a brown box on a brown dialog. dark.css gives these the orange.
const accents = new Map<string, string>();
postcss.parse(readFileSync(join(__dirname, 'dark.css'), 'utf8')).walkDecls('accent-color', (decl) => {
  const rule = decl.parent as postcss.Rule;
  for (const selector of rule.selectors) accents.set(selector, decl.value);
});

test.each(['.membership-consent input', '.plans-check input', '.studio-terms__policy input', '.studio-terms__confirm input'])(
  'dark mode gives the %s checkbox a visible accent',
  (selector) => {
    expect(accents.get(`:root[data-theme='dark'] ${selector}`)).toBe('var(--orange)');
  },
);
