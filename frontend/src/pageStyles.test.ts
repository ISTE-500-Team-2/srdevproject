import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

// Page code loads lazily, but its stylesheets must load up front in pageStyles.ts:
// a stylesheet imported only from a lazily loaded page would land after styles.css
// and tables.css and silently win the cascade. Add new page styles there.
const src = path.dirname(new URL(import.meta.url).pathname);
// main.tsx loads the global sheets after pageStyles; Lanyard's sheet is emitted last, where it
// sat when it loaded with the lazy 3D badge; CodeSlots.jsx is unused (add its sheet when it isn't).
const loadedElsewhere = new Set(['styles.css', 'tables.css', 'components/reactbits/Lanyard.css', 'components/reactbits/CodeSlots.css']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [file] : [];
  });
}

test('every stylesheet the app imports is loaded up front, in pageStyles.ts', () => {
  const eager = new Set([...readFileSync(path.join(src, 'pageStyles.ts'), 'utf8').matchAll(/import '\.\/([^']+\.css)'/g)].map((m) => m[1]));
  const imported = new Set<string>();
  for (const file of sources(src))
    for (const m of readFileSync(file, 'utf8').matchAll(/import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/g))
      imported.add(path.relative(src, path.resolve(path.dirname(file), m[1])));
  const missing = [...imported].filter((css) => !eager.has(css) && !loadedElsewhere.has(css));
  expect(missing).toEqual([]);
  expect([...eager].filter((css) => !imported.has(css))).toEqual([]);
});
