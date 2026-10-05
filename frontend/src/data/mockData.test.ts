import { describe, expect, it } from 'vitest';
import { classes } from './mockData';

describe('class preview data', () => {
  it('uses unique class ids', () => {
    expect(new Set(classes.map(item => item.id)).size).toBe(classes.length);
  });

  it('provides valid capacity and pricing for interactive cards', () => {
    expect(classes.every(item => item.capacity > item.enrolled && item.price >= 0)).toBe(true);
  });
});
