// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PageTitle } from './PageTitle';

afterEach(cleanup);
test('names the tab after the page, and falls back to the site name', () => {
  const { rerender } = render(<PageTitle title="Membership" />);
  expect(document.title).toBe('Membership · The Collaboratory');
  rerender(<PageTitle />);
  expect(document.title).toBe('The Collaboratory');
});
