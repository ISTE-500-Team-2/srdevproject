// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HOLD_MAX_MS, SETTLE_MS, useSteadyHeight } from "./steadyHeight";

// jsdom has no layout: heights are set by hand and the resize observer is fired by the test.
let resized: () => void;
class FakeResizeObserver {
  constructor(callback: () => void) {
    resized = callback;
  }
  observe() {}
  disconnect() {}
}
const height = (el: HTMLElement, px: number) => Object.defineProperty(el, "offsetHeight", { configurable: true, value: px });

function Column({ path, loading = false }: { path: string; loading?: boolean }) {
  const { column, content, holdNow } = useSteadyHeight(path);
  return (
    <main ref={column} style={{ paddingTop: "20px", paddingBottom: "40px" }}>
      <div ref={content}>
        {path}
        {loading ? <p data-loading="">Loading records…</p> : null}
        <button type="button" onClick={holdNow}>
          Other view
        </button>
      </div>
    </main>
  );
}
const parts = () => {
  const main = document.querySelector("main")!;
  return { main, page: main.firstElementChild as HTMLElement };
};
/** Lets the mutation observer report, then runs timers. */
const after = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The next page's first layout: a short "Loading…" (or a short page). */
const short = () => height(parts().page, 120);
/** Lays out a tall page, as the resize observer would report it. */
const tall = () => {
  const { main, page } = parts();
  height(main, 2000);
  height(page, 1940);
  resized();
};

test("arriving in the workspace holds nothing", () => {
  render(<Column path="/admin" />);
  expect(parts().main.style.minHeight).toBe("");
});

test("a page change holds the last height until the new page grows to it", async () => {
  const { rerender } = render(<Column path="/admin" />);
  tall();
  short();
  rerender(<Column path="/admin/payments" loading />);
  const { main, page } = parts();
  expect(main.style.minHeight).toBe("2000px");
  resized();
  expect(main.style.minHeight).toBe("2000px");
  // The results land: 1950 + 60 padding reaches the held height.
  height(page, 1950);
  rerender(<Column path="/admin/payments" />);
  resized();
  expect(main.style.minHeight).toBe("");
});

test("however slow the load, the hold lasts while the page shows it is loading", async () => {
  const { rerender } = render(<Column path="/admin" />);
  tall();
  short();
  rerender(<Column path="/admin/payments" loading />);
  const { main, page } = parts();
  await after(5000);
  expect(main.style.minHeight).toBe("2000px");
  // Loaded, and shorter than before: the scrollbar goes, once, after the page settles.
  height(page, 600);
  rerender(<Column path="/admin/payments" />);
  await after(SETTLE_MS - 1);
  expect(main.style.minHeight).toBe("2000px");
  await after(1);
  expect(main.style.minHeight).toBe("");
});

test("a page with nothing to load that is shorter lets go once it settles", async () => {
  const { rerender } = render(<Column path="/admin" />);
  tall();
  short();
  rerender(<Column path="/admin/plans" />);
  await after(SETTLE_MS - 1);
  expect(parts().main.style.minHeight).toBe("2000px");
  await after(1);
  expect(parts().main.style.minHeight).toBe("");
});

test("a request that never answers doesn't hold forever", async () => {
  const { rerender } = render(<Column path="/admin" />);
  tall();
  short();
  rerender(<Column path="/admin/payments" loading />);
  await after(HOLD_MAX_MS - 1);
  expect(parts().main.style.minHeight).toBe("2000px");
  await after(1);
  expect(parts().main.style.minHeight).toBe("");
});

test("a second page change before the first settles keeps holding the same height", () => {
  const { rerender } = render(<Column path="/admin" />);
  tall();
  short();
  rerender(<Column path="/admin/payments" loading />);
  // The next page's "Loading…" is what a fresh measurement would see.
  height(parts().main, 400);
  rerender(<Column path="/admin/members" loading />);
  const { main } = parts();
  expect(main.style.minHeight).toBe("2000px");
});

test("a change of query alone (a filter in the URL) holds nothing", () => {
  const { rerender } = render(<Column path="/admin/members" />);
  tall();
  rerender(<Column path="/admin/members" />);
  expect(parts().main.style.minHeight).toBe("");
});

test("a page swapping views in place holds its height while the other view loads", async () => {
  const { rerender } = render(<Column path="/admin/reservations" />);
  tall();
  fireEvent.click(screen.getByRole("button", { name: "Other view" }));
  short();
  rerender(<Column path="/admin/reservations" loading />);
  const { main, page } = parts();
  await after(3000);
  expect(main.style.minHeight).toBe("2000px");
  height(page, 1950);
  rerender(<Column path="/admin/reservations" />);
  resized();
  expect(main.style.minHeight).toBe("");
});
