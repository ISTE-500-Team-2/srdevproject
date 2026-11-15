// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { paintFace } from "./MemberBadge";

const H = 1440;
const FOOTER_TOP = H - 250;
type Call = { text: string; y: number; px: number };
let texts: Call[];
let rects: { x: number; y: number; w: number; h: number; fill: string }[];
let images: { x: number; y: number; w: number; h: number }[];

beforeEach(() => {
  texts = [];
  rects = [];
  images = [];
  // A recording 2D context: enough to check where the face puts things.
  const ctx = {
    font: "10px Barlow",
    fillStyle: "",
    letterSpacing: "0px",
    textAlign: "start",
    measureText(text: string) {
      return { width: text.length * (Number(/(\d+)px/.exec(this.font)?.[1]) || 10) * 0.55 };
    },
    fillText(text: string, _x: number, y: number) {
      texts.push({ text, y, px: Number(/(\d+)px/.exec(this.font)?.[1]) });
    },
    fillRect() {},
    drawImage(_image: unknown, x: number, y: number, w: number, h: number) {
      images.push({ x, y, w, h });
    },
    save() {},
    restore() {},
    arc() {},
    clip() {},
    stroke() {},
    beginPath() {},
    roundRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: this.fillStyle });
    },
    fill() {},
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,");
  // jsdom never loads images: the logo fails fast so the face paints without it, and a
  // data-URL photo "loads" as a 256px square.
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      width = 256;
      height = 256;
      set src(value: string) {
        queueMicrotask(() => (value.startsWith("data:image/") ? this.onload?.() : this.onerror?.()));
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("an adult badge has no Under 18 tag or sponsor line", async () => {
  await paintFace("Dana Reyes", "Active membership", 7);
  expect(texts.map((t) => t.text)).toEqual(["MEMBER", "Dana Reyes", "Active membership", "ID 000007"]);
  expect(rects).toHaveLength(0);
});

test("a minor's UNDER 18 tag and sponsor clear the footer band without overlapping", async () => {
  await paintFace("Emma Lin", "Active membership", 142, true, "Dana Reyes");
  const tag = rects[0]!;
  expect(tag.fill).toBe("#f7961d");
  const access = texts.find((t) => t.text === "Active membership")!;
  const sponsor = texts.find((t) => t.text === "With Dana Reyes")!;
  expect(texts.find((t) => t.text === "UNDER 18")).toBeTruthy();
  // Access line sits above the tag; the sponsor line sits below it.
  expect(access.y).toBeLessThan(tag.y);
  expect(sponsor.y - sponsor.px).toBeGreaterThan(tag.y + tag.h);
  // Descenders included, nothing reaches the footer.
  expect(sponsor.y + sponsor.px * 0.25).toBeLessThan(FOOTER_TOP);
  expect(tag.y + tag.h).toBeLessThan(FOOTER_TOP);
  expect(texts.some((t) => t.text.startsWith("Adult:"))).toBe(false);
});

test("with no sponsor linked the adult line is left off, never staff instructions", async () => {
  await paintFace("Emma Lin", "Active membership", 142, true, null);
  const words = texts.map((t) => t.text);
  expect(words).toContain("UNDER 18");
  expect(words.some((t) => /With|Adult|staff/i.test(t))).toBe(false);
});

test("a profile photo sits in a circle below the header and clear of MEMBER, for adults and minors", async () => {
  for (const minor of [false, true]) {
    texts = [];
    images = [];
    await paintFace("Dana Reyes", "Active membership", 7, minor, minor ? "Sam Reyes" : null, "data:image/webp;base64,UklGRg==");
    const photo = images.at(-1)!;
    const member = texts.find((t) => t.text === "MEMBER")!;
    expect(photo.w).toBe(photo.h);
    expect(photo.x + photo.w / 2).toBe(512);
    expect(photo.y).toBeGreaterThan(130); // below the header strap
    expect(photo.y + photo.h).toBeLessThan(member.y - member.px); // above MEMBER's cap height
  }
});

test("a photo that can't be decoded leaves the badge as it was", async () => {
  await paintFace("Dana Reyes", "Active membership", 7, false, null, "https://example.invalid/not-a-data-url");
  expect(images).toHaveLength(0);
  expect(texts.map((t) => t.text)).toEqual(["MEMBER", "Dana Reyes", "Active membership", "ID 000007"]);
});
