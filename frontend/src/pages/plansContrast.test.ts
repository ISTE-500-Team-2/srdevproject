import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { expect, test } from "vitest";
import { contrast, mapColor, parseColor } from "../theme/darkCompiler";

// Hints, "/ month", "No discounts" and the small section headings are 12-13px text in
// --plans-muted, so they need 4.5:1 on the Plans panel in both themes. The dark compiler
// skips custom properties, so the variable must follow a theme token to change with it.
function value(file: string, selector: string, prop: string) {
  let found = "";
  postcss.parse(readFileSync(join(__dirname, "..", file), "utf8")).walkRules((rule) => {
    if (rule.selectors.includes(selector)) rule.walkDecls(prop, (decl) => { found = decl.value; });
  });
  return found;
}
const color = (text: string) => parseColor(text)!;
const token = value("pages/plans.css", ".plans", "--plans-muted").match(/^var\((--[\w-]+)\)$/)?.[1] ?? "";
const panel = color(value("pages/plans.css", ".plans-editor", "background"));

test("Plans muted text follows a theme token", () => {
  expect(token).not.toBe("");
});

test("Plans muted text keeps 4.5:1 on the light panel", () => {
  const paper = color(value("styles.css", ":root", "--paper"));
  const mix = (c: "r" | "g" | "b") => panel[c] * panel.a + paper[c] * (1 - panel.a);
  const surface = { r: mix("r"), g: mix("g"), b: mix("b"), a: 1 };
  expect(contrast(color(value("styles.css", ":root", token)), surface)).toBeGreaterThanOrEqual(4.5);
});

test("Plans muted text keeps 4.5:1 on the dark panel", () => {
  const surface = mapColor(panel, "surface");
  expect(contrast(color(value("theme/dark.css", ":root[data-theme='dark']", token)), surface)).toBeGreaterThanOrEqual(4.5);
});
