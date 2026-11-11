// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { ScrollToTopOnNavigate } from './App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('a new page starts at the top; query and hash changes keep the reader in place', () => {
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  render(<MemoryRouter initialEntries={['/admin/members']}>
    <ScrollToTopOnNavigate />
    <Link to="/admin/members?search=ada">Filter</Link>
    <Link to="/admin/members#records">Section</Link>
    <Link to="/admin/payments">Payments</Link>
  </MemoryRouter>);
  // Arriving does not fight the browser's own restoration or a #section landing.
  expect(scrollTo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Filter'));
  fireEvent.click(screen.getByText('Section'));
  expect(scrollTo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Payments'));
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});
