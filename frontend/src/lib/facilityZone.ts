import { useApi } from "./useApi";
import { localHour } from "./today";

/** The zone used when /config cannot be read, as the other staff pages do. */
export const FALLBACK_FACILITY_ZONE = "America/New_York";

/**
 * The facility's time zone from /config, which reporting periods are counted in.
 * Null while /config is still loading (usually it is already stored at startup), so a
 * page can wait instead of first asking for the wrong days; the fallback zone if
 * /config cannot be read.
 */
export function useFacilityZone(): string | null {
  const config = useApi<{ timeZone: string }>("/config", { reuse: true });
  return config.data?.timeZone ?? (config.loading ? null : FALLBACK_FACILITY_ZONE);
}

/** Midnight at the start of `day` (YYYY-MM-DD) in `zone`, as an ISO instant. */
export const zonedDayStart = (day: string, zone: string) => new Date(localHour(day, 0, zone)).toISOString();
