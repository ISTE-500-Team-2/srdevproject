// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { PageWidthContext, usePageWidth, type PageWidth } from './pageWidth';

afterEach(cleanup);

function Page({ width }: { width?: PageWidth }) { usePageWidth(width); return null; }
/** The shell's part: hold the width the current page declares and show it. */
function Shell({ page }: { page: React.ReactNode }) {
  const [width, setWidth] = useState<PageWidth>('standard');
  return <main data-testid="main" data-width={width}><PageWidthContext.Provider value={setWidth}>{page}</PageWidthContext.Provider></main>;
}
const width = () => screen.getByTestId('main').getAttribute('data-width');

test('a page sets its width while mounted and the shell returns to standard after', () => {
  const view = render(<Shell page={<Page width="wide" />} />);
  expect(width()).toBe('wide');
  view.rerender(<Shell page={<Page key="other" width="narrow" />} />);
  expect(width()).toBe('narrow');
  view.rerender(<Shell page={null} />);
  expect(width()).toBe('standard');
});

test('an undeclared outer page leaves the choice to the page inside it', () => {
  render(<Shell page={<><Page /><Page width="wide" /></>} />);
  expect(width()).toBe('wide');
});
