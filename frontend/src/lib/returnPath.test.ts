// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { loginPath, safeNext } from './returnPath';

test.each([
  ['/membership', '/membership'],
  ['/admin/members?status=active#top', '/admin/members?status=active#top'],
  ['/classes/../membership', '/membership'],
])('keeps the site path %s', (raw, expected) => {
  expect(safeNext(raw)).toBe(expected);
});

test.each([
  null, '', 'membership', '//evil.example', '/\\evil.example', '/\t/evil.example',
  'https://evil.example/', 'javascript:alert(1)', '/login', '/login?next=%2Fmembership',
  '/LOGIN', '/login/', '/%6cogin', '/Login//', '/bad%E0%A4%A', '/.//login', '/.//evil.example/x', '/a/..//b',
])('refuses %j, which could leave the site or loop back to login', (raw) => {
  expect(safeNext(raw)).toBeNull();
});

test('login links carry the page to return to, except for home', () => {
  expect(loginPath({ pathname: '/membership', search: '?plan=2', hash: '' })).toBe('/login?next=%2Fmembership%3Fplan%3D2');
  expect(loginPath({ pathname: '/', search: '', hash: '' })).toBe('/login');
});
