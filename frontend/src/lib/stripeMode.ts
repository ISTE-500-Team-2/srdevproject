// The server's Stripe mode. Test-mode notices ("you won't be charged") show only when it is test.

import { useApi } from "./useApi";

export type StripeMode = "test" | "live";

/** The mode from the shared /config read; undefined until it loads, so no test notice shows early. */
export function useStripeMode(): StripeMode | undefined {
  return useApi<{ stripeMode?: StripeMode }>("/config", { reuse: true }).data?.stripeMode;
}
