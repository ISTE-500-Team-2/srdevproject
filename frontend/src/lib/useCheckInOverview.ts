import { useState } from 'react';
import type { Overview } from './contracts';
import { useApi } from './useApi';

export function useCheckInOverview(userId?: number) {
  const [selection, setSelection] = useState<{userId?: number; buildingId: number} | null>(null);
  const requested = selection?.userId === userId ? selection?.buildingId : undefined;
  const overview = useApi<Overview>(`/me/overview${requested === undefined ? '' : `?buildingId=${requested}`}`, {requestKey:userId});
  const data = overview.data?.userId === userId ? overview.data : null;
  const buildingId = requested ?? data?.checkInBuildingId ?? null;
  // A previous response cannot enable check-in for a newly selected building.
  const ready = !overview.loading && !overview.error && buildingId !== null
    && data?.checkInBuildingId === buildingId;
  return {
    ...overview,
    data,
    buildingId,
    ready,
    selectBuilding: (id: number) => setSelection({userId, buildingId:id}),
  };
}
