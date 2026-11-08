// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LoadingPage } from './LoadingPage';

afterEach(cleanup);
function Landed() {
  const { pathname, search } = useLocation();
  return <p>Landed on {pathname + search}</p>;
}
function open(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/loading" element={<LoadingPage />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('continues to a page on this site', async () => {
  open('/loading?next=%2Fmembership');
  expect(await screen.findByText('Landed on /membership', {}, { timeout: 4000 })).toBeTruthy();
});

test.each(['%2F%2Fevil.example', 'https%3A%2F%2Fevil.example', '%2Floading%3Fnext%3D%252F%252Fevil.example'])(
  'refuses next=%s and goes home instead', async (next) => {
    open(`/loading?next=${next}`);
    expect(await screen.findByText('Landed on /', {}, { timeout: 4000 })).toBeTruthy();
  },
);
