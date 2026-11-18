// Loads the selected member/building check-in overview and guards against stale selection responses.

import { useState } from 'react';
import type { Overview } from './contracts';
import { useApi } from './useApi';

/**
 * Bind building selection and readiness to the current user; an older user/building response must
 * never enable check-in.
 */
export function useCheckInOverview(userId?: number) {
  const [selection, setSelection] = useState<{userId?: number; buildingId: number} | null>(null);
  const requested = selection?.userId === userId ? selection?.buildingId : undefined;
  // The previous building's overview stays on screen while the chosen one loads, so the page
  // (and the building select with keyboard focus) is not torn down on every change.
  const overview = useApi<Overview>(`/me/overview${requested === undefined ? '' : `?buildingId=${requested}`}`, {requestKey:userId, retainOnChange:true});
  const data = overview.data?.userId === userId ? overview.data : null;
  const buildingId = requested ?? data?.checkInBuildingId ?? null;
  // A previous response cannot enable check-in for a newly selected building.
  const ready = !overview.loading && !overview.error && buildingId !== null
    && data?.checkInBuildingId === buildingId;
  return {
    ...overview,
    data,
    // Another account's overview is never shown, so until this one's arrives it is loading.
    loading: overview.loading || (overview.refreshing && overview.data !== null && data === null),
    buildingId,
    ready,
    selectBuilding: (id: number) => setSelection({userId, buildingId:id}),
  };
}
