// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Toast } from './Toast';

afterEach(cleanup);

test('a confirmation is a polite status; a problem is an alert in the warning style', () => {
  const { rerender } = render(<Toast message="Refunded $50.00." onClose={() => undefined} />);
  expect(screen.getByRole('status').className).toBe('toast');
  rerender(<Toast message="Stripe didn't complete the refund." tone="problem" onClose={() => undefined} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert').className).toBe('toast toast--problem');
});
