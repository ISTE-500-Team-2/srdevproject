import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LineChart } from './Charts';
import { lineCoordinates } from '../lib/chartCoordinates';

describe('existing chart geometry', () => {
  it('places zero, midpoint and maximum on the existing plot bounds', () => {
    expect(lineCoordinates([0, 50, 100], 100, 900, 270)).toEqual([
      { x: 0, y: 228 }, { x: 450, y: 120 }, { x: 900, y: 12 },
    ]);
    const svg = renderToStaticMarkup(<LineChart values={[0, 50, 100]} labels={['A', 'B', 'C']} max={100} />);
    expect(svg).toContain('points="0,228 450,120 900,12"');
    expect(svg).toContain('cx="450" cy="120"');
    expect(svg).toContain('points="0,228 0,228 450,120 900,12 900,228"');
  });

  it('keeps single points at the left edge and empty series empty', () => {
    expect(lineCoordinates([50], 100, 900, 270)).toEqual([{ x: 0, y: 120 }]);
    expect(lineCoordinates([], 100, 900, 270)).toEqual([]);
    const svg = renderToStaticMarkup(<LineChart values={[]} labels={[]} max={100} />);
    expect(svg).not.toContain('<circle');
  });

  it('preserves compact height and unclamped values', () => {
    expect(lineCoordinates([-100, 200], 100, 900, 150)).toEqual([
      { x: 0, y: 204 }, { x: 900, y: -84 },
    ]);
  });
});
