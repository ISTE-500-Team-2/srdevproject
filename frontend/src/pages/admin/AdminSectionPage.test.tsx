// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { PageWidthContext, type PageWidth } from '../../components/admin/pageWidth';
import { AdminSectionPage } from './AdminSectionPage';
import { adminGroups } from './sections';

afterEach(cleanup);

function Shell({ path }: { path: string }) {
  const [width, setWidth] = useState<PageWidth>('standard');
  const section = adminGroups.flatMap(group => group.sections).find(item => item.path === path)!;
  return <main data-testid="main" data-width={width}><PageWidthContext.Provider value={setWidth}>
    <MemoryRouter><AdminSectionPage section={{ ...section, component: () => null }} /></MemoryRouter>
  </PageWidthContext.Provider></main>;
}
const width = () => screen.getByTestId('main').getAttribute('data-width');

test('each section keeps its own page width: the members table is wide, other pages keep the standard cap', () => {
  render(<Shell path="members" />);
  expect(width()).toBe('wide');
  cleanup();
  // Service notices was rebuilt (#126) as a status list like Payments, so it uses the standard width.
  render(<Shell path="service-notices" />);
  expect(width()).toBe('standard');
  cleanup();
  render(<Shell path="change-log" />);
  expect(width()).toBe('standard');
});

test('the page title carries its sidebar group as a label', () => {
  render(<Shell path="change-log" />);
  expect(screen.getByRole('heading', { level: 1, name: 'Change log' }).previousElementSibling?.textContent).toBe('Records');
});
