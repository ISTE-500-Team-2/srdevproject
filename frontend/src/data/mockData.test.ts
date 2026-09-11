import { describe, expect, it } from 'vitest';
import { certifications, classes, demoUsers, equipment, studioSpaces, waivers } from './mockData';

describe('prototype data', () => {
  it('keeps demo accounts mapped to their intended roles', () => {
    expect(demoUsers.member.role).toBe('member');
    expect(demoUsers.admin.role).toBe('admin');
  });

  it('uses unique ids within each reservable collection', () => {
    const hasUniqueIds = (items: Array<{ id: number }>) =>
      new Set(items.map((item) => item.id)).size === items.length;

    expect(hasUniqueIds(equipment)).toBe(true);
    expect(hasUniqueIds(studioSpaces)).toBe(true);
    expect(hasUniqueIds(classes)).toBe(true);
  });

  it('provides valid capacity and pricing values for interactive cards', () => {
    expect(classes.every((item) => item.capacity > item.enrolled && item.price >= 0)).toBe(true);
    expect(equipment.every((item) => item.rate > 0)).toBe(true);
    expect(studioSpaces.every((item) => item.monthlyRate > 0)).toBe(true);
  });

  it('has records for both credential sections', () => {
    expect(certifications.length).toBeGreaterThan(0);
    expect(waivers.length).toBeGreaterThan(0);
  });
});
