/**
 * SVG points for a line chart `width` x `height` user units. Points are spaced
 * evenly from x=0 to x=width (one point sits at x=0). The bottom 42 units are
 * left for axis labels, so 0 maps to y=height-42 and `max` to y=12.
 *
 * Inputs are not validated: `max` must be positive and finite, and values are
 * not clamped, so a value above `max` or below 0 is drawn past the plot area.
 */
export function lineCoordinates(
  values: number[],
  max: number,
  width: number,
  height: number,
) {
  const usableHeight = height - 42;
  const step = width / Math.max(values.length - 1, 1);
  return values.map((value, index) => ({
    x: index * step,
    y: usableHeight - (value / max) * (usableHeight - 12),
  }));
}
