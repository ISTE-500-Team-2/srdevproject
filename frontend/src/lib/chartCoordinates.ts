// Keep the existing geometry, including unclamped values. Validation is not a
// structural-refactor concern; labels intentionally use their own spacing.
export function lineCoordinates(values: number[], max: number, width: number, height: number) {
  const usableHeight = height - 42;
  const step = width / Math.max(values.length - 1, 1);
  return values.map((value, index) => ({
    x: index * step,
    y: usableHeight - (value / max) * (usableHeight - 12),
  }));
}
