import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

// Page code loads lazily, but its stylesheets must load up front in pageStyles.ts:
// a stylesheet imported only from a lazily loaded page would land after styles.css
// and tables.css and silently win the cascade. Add new page styles there.
const src = path.dirname(new URL(import.meta.url).pathname);
// main.tsx loads the global sheets and the dark theme after pageStyles; Lanyard's sheet is emitted last, where it
// sat when it loaded with the lazy 3D badge.
const loadedElsewhere = new Set(['styles.css', 'tables.css', 'theme/dark.css', 'components/reactbits/Lanyard.css']);

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

// The cascade order shipped before page code was split: changing it can change how
// pages look (equal-specificity rules resolve by order), so it changes only on purpose.
const SHIPPED_ORDER = [
  'components/reactbits/HoldButton.css',
  'pages/certwaiver.css',
  'components/reactbits/StatusMark.css',
  'components/monthCalendar.css',
  'pages/studios.css',
  'components/EquipmentPriceBreakdown.css',
  'pages/admin/equipment.css',
  'assets/css/analyticsDashboard.css',
  'pages/plans.css',
  'components/appearanceControl.css',
  'pages/admin/today.css',
  'components/reactbits/CardNav.css',
  'pages/classes.css',
  'pages/certifications.css',
  'components/reactbits/SpringCheck.css',
  'components/reactbits/Stepper.css',
  'pages/profile.css',
  'pages/membership.css',
  'management.css',
  'admin.css',
  // Added after the split; they only extend management.css rules.
  'components/staff/paymentTable.css',
  'pages/payments.css',
  'components/staff/record/memberRecord.css',
  'components/staff/reservations/reservations.css',
  'pages/admin/serviceNotices.css',
];

test('page styles keep their shipped order, ahead of the app and the global sheets', () => {
  const eager = [...readFileSync(path.join(src, 'pageStyles.ts'), 'utf8').matchAll(/import '\.\/([^']+\.css)'/g)].map((m) => m[1]);
  expect(eager).toEqual(SHIPPED_ORDER);
  const main = [...readFileSync(path.join(src, 'main.tsx'), 'utf8').matchAll(/import\s+(?:\w+\s+from\s+)?'(\.\/[^']+)'/g)].map((m) => m[1]);
  const at = (name: string) => main.indexOf(name);
  expect(at('./pageStyles')).toBeGreaterThanOrEqual(0);
  expect(at('./pageStyles')).toBeLessThan(at('./App'));
  expect(at('./App')).toBeLessThan(at('./styles.css'));
  expect(at('./styles.css')).toBeLessThan(at('./tables.css'));
  expect(at('./tables.css')).toBeLessThan(at('./theme/dark.css'));
});
