// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { KeptResults, useResultsPaging } from "./KeptResults";
import { Pager } from "./Management";

afterEach(cleanup);

type Read = { data: { rows: string[]; nextOffset: number | null } | null; stale: boolean };
/** A paged list whose read is driven from the test, like a page using useApi `retainOnChange`. */
function List({ read, onPage }: { read: Read; onPage: (offset: number) => void }) {
  const [offset, setOffset] = useState(50);
  const { results, turn, busy } = useResultsPaging(read);
  return (
    <>
      <label>
        Filter <input />
      </label>
      <KeptResults read={read} ref={results}>
        {read.data?.rows.map((row) => (
          <button key={row} type="button">
            {row}
          </button>
        ))}
      </KeptResults>
      <Pager
        offset={offset}
        nextOffset={read.data?.nextOffset ?? null}
        busy={busy}
        onChange={(next) =>
          turn(() => {
            setOffset(next);
            onPage(next);
          })
        }
      />
    </>
  );
}
const box = () => document.querySelector(".kept-results")!;

test("stale results stay on screen but fade out of reach; current ones are usable", () => {
  const { rerender } = render(<KeptResults read={{ data: [], stale: false }}>rows</KeptResults>);
  expect(box().hasAttribute("inert")).toBe(false);
  expect(box().hasAttribute("aria-busy")).toBe(false);
  expect(box().hasAttribute("tabindex")).toBe(false);
  rerender(<KeptResults read={{ data: [], stale: true }}>rows</KeptResults>);
  expect(box().textContent).toBe("rows");
  expect(box().hasAttribute("inert")).toBe(true);
  expect(box().getAttribute("aria-busy")).toBe("true");
});

test("paging keeps focus on the pager while the page loads, then moves it to the new results", () => {
  const onPage = vi.fn();
  const first: Read = { data: { rows: ["Row 51"], nextOffset: 100 }, stale: false };
  const { rerender } = render(<List read={first} onPage={onPage} />);
  const previous = screen.getByRole("button", { name: "Previous page" });
  previous.focus();
  fireEvent.click(previous);
  expect(onPage).toHaveBeenCalledWith(0);

  // Page one is on its way. At offset 0 Previous would normally be disabled (which drops focus)
  // and the pager could vanish; while busy both stay, focusable, and do nothing.
  rerender(<List read={{ ...first, stale: true }} onPage={onPage} />);
  expect(document.activeElement).toBe(previous);
  expect((previous as HTMLButtonElement).disabled).toBe(false);
  expect(previous.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(onPage).toHaveBeenCalledTimes(1);
  expect(box().hasAttribute("inert")).toBe(true);
  expect(box().contains(previous)).toBe(false);

  rerender(<List read={{ data: { rows: ["Row 1"], nextOffset: 50 }, stale: false }} onPage={onPage} />);
  expect(document.activeElement).toBe(box());
  expect(box().getAttribute("tabindex")).toBe("-1");
  expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a filter change doesn't move focus when its results land", () => {
  const first: Read = { data: { rows: ["Row 51"], nextOffset: 100 }, stale: false };
  const { rerender } = render(<List read={first} onPage={vi.fn()} />);
  const filter = screen.getByLabelText("Filter");
  filter.focus();
  rerender(<List read={{ ...first, stale: true }} onPage={vi.fn()} />);
  rerender(<List read={{ data: { rows: ["Other row"], nextOffset: null }, stale: false }} onPage={vi.fn()} />);
  expect(document.activeElement).toBe(filter);
});

test("paging from below the results brings their top into view at once", () => {
  render(<List read={{ data: { rows: ["Row 51"], nextOffset: 100 }, stale: false }} onPage={vi.fn()} />);
  const scrollIntoView = vi.fn();
  Object.assign(box(), { scrollIntoView, getBoundingClientRect: () => ({ top: -400 }) });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
});

test("a pager with nothing to page through stays hidden unless a page is loading", () => {
  const { rerender } = render(<Pager offset={0} nextOffset={null} onChange={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  rerender(<Pager offset={0} nextOffset={null} busy onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
});

test("someone who moves on while the page loads keeps their place", () => {
  const first: Read = { data: { rows: ["Row 51"], nextOffset: 100 }, stale: false };
  const { rerender } = render(<List read={first} onPage={vi.fn()} />);
  const next = screen.getByRole("button", { name: "Next page" });
  next.focus();
  fireEvent.click(next);
  rerender(<List read={{ ...first, stale: true }} onPage={vi.fn()} />);
  const filter = screen.getByLabelText("Filter");
  filter.focus();
  rerender(<List read={{ data: { rows: ["Row 101"], nextOffset: null }, stale: false }} onPage={vi.fn()} />);
  expect(document.activeElement).toBe(filter);
});

test("a page that fails to load moves focus neither then nor on a later load", () => {
  const first: Read = { data: { rows: ["Row 51"], nextOffset: 100 }, stale: false };
  const { rerender } = render(<List read={first} onPage={vi.fn()} />);
  const next = screen.getByRole("button", { name: "Next page" });
  next.focus();
  fireEvent.click(next);
  rerender(<List read={{ ...first, stale: true }} onPage={vi.fn()} />);
  // The request fails: useApi drops the kept results and reports the error.
  rerender(<List read={{ data: null, stale: false }} onPage={vi.fn()} />);
  expect(document.activeElement).toBe(next);
  // Later, a filter change loads fine. Focus is still on the button that turned the failed page,
  // which would pull focus to the results if that promise had outlived the failure.
  rerender(<List read={{ data: { rows: ["Row 1"], nextOffset: 50 }, stale: true }} onPage={vi.fn()} />);
  rerender(<List read={{ data: { rows: ["Row 1"], nextOffset: 50 }, stale: false }} onPage={vi.fn()} />);
  expect(document.activeElement).toBe(next);
});
