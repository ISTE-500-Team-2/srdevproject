// How the member Equipment page groups machines into cards; the add-equipment preview uses the same rule.

/** The display group for a machine type, shared by the equipment tiles and booking rows. */
export function equipmentGroup(rawType: string) {
  const category = rawType.trim();
  return /^3d[ -]*(print|printing|printer)$/i.test(category) ? '3D Printer'
    : /\bcnc\b/i.test(category) ? 'CNC Machine'
    : /\blathe\b/i.test(category) ? 'Lathe'
    : /^laser( engraver)?$/i.test(category) ? 'Laser Engraver'
    : category || 'Other equipment';
}
