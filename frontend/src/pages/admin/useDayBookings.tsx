import { useCallback, useEffect, useState } from "react";
import type { Reservation } from "../../lib/contracts";
import type { Page } from "../../lib/staffContracts";
import { equipmentBookings } from "../../lib/today";
import { useApi } from "../../lib/useApi";

type Result<T> = { data: T | null; loading: boolean; error: string; reload: () => void };
type Refresh = { retainOnReload: boolean; refreshInterval: number };

// The staff bookings list is paged; each page keeps its own refresh and retry.
// `failedError` is the last failure, kept until a read succeeds: a retry clears
// `error` as soon as it starts while the page still holds the older data.
type BookingPageResult = Result<Page<Reservation>> & { failedError: string };
function BookingPage({ day, offset, refresh, receive }: { day: string; offset: number; refresh: Refresh; receive: (offset: number, result: BookingPageResult) => void }) {
  const { data, loading, error, reload } = useApi<Page<Reservation>>(
    `/admin/reservations?date=${day}${offset ? `&offset=${offset}` : ""}`,
    refresh,
  );
  const [failure, setFailure] = useState<{ error: string; data: Page<Reservation> | null } | null>(null);
  useEffect(() => {
    if (error) setFailure({ error, data });
  }, [error, data]);
  // Only a successful read replaces the data, which ends the failure.
  const failedError = error || (failure && failure.data === data ? failure.error : "");
  useEffect(() => {
    receive(offset, { data, loading, error, reload, failedError });
  }, [offset, receive, data, loading, error, reload, failedError]);
  return null;
}

/**
 * Every equipment booking on one day, across all pages of the staff bookings list.
 * Render `loaders` somewhere in the tree: each page is fetched by its own component.
 * `state` is the first page still loading or failed, or undefined once all have loaded.
 * `failed` is set while any page's latest completed read failed, even if it still holds
 * older data or is retrying; it clears once that page reads successfully.
 */
export function useDayBookings(day: string, refresh: Refresh) {
  const [pages, setPages] = useState<Record<number, BookingPageResult>>({});
  const receive = useCallback(
    (offset: number, result: BookingPageResult) => setPages((previous) => ({ ...previous, [offset]: result })),
    [],
  );
  const offsets = [0];
  for (let next = pages[0]?.data?.nextOffset; next != null && !offsets.includes(next); next = pages[next]?.data?.nextOffset)
    offsets.push(next);
  const missing = offsets.map((offset) => pages[offset]).find((page) => !page?.data);
  const state: Result<unknown> | undefined = offsets.every((offset) => pages[offset]?.data)
    ? undefined
    : (missing ?? { data: null, loading: true, error: "", reload: () => {} });
  // A failed refresh keeps the page's older data, so `state` alone would not show it.
  const failedPage = offsets.map((offset) => pages[offset]).find((page) => page?.failedError);
  const failed = failedPage ? { error: failedPage.failedError, reload: failedPage.reload } : undefined;
  const bookings = equipmentBookings(offsets.flatMap((offset) => pages[offset]?.data?.items ?? []));
  const loaders = day
    ? offsets.map((offset) => <BookingPage key={offset} day={day} offset={offset} refresh={refresh} receive={receive} />)
    : null;
  // Re-reads every page in place, keeping the current bookings on screen meanwhile.
  const reload = () => offsets.forEach((offset) => pages[offset]?.reload());
  return { bookings, state, failed, loaders, reload };
}

