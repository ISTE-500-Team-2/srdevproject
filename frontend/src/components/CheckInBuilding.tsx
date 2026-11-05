import type { Overview } from '../lib/contracts';

export function CheckInBuilding({buildings, buildingId, onChange, disabled = false}: {
  buildings: Overview['buildings'];
  buildingId: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
}) {
  if (!buildings?.length) return null;
  if (buildings.length === 1) return <p>Building: {buildings[0]!.name}</p>;
  return <label className="form-field">
    Check-in building
    <select value={buildingId ?? ''} onChange={event => onChange(Number(event.target.value))} disabled={disabled}>
      <option value="" disabled>Choose a building</option>
      {buildings.map(building => <option key={building.id} value={building.id} disabled={building.status !== 'available'}>
        {building.name}{building.status !== 'available' ? ' (unavailable)' : ''}
      </option>)}
    </select>
  </label>;
}
