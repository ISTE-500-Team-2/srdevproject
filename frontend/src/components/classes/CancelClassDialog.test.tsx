// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { api } from '../../lib/api';
import { CancelClassDialog } from './CancelClassDialog';
import type { ClassRecord } from './classData';

vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api: vi.fn() }));
// jsdom has no ResizeObserver; the hold-to-cancel button measures itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const klass: ClassRecord = {
  id: 5, title: 'Laser basics', certificationId: 7, certificationName: 'Laser cutting', instructorId: 1, instructor: 'Morgan Reyes',
  capacity: 3, enrolled: 2, status: 'scheduled', revision: 4, roomId: 2, roomName: 'Training Room',
  startsAt: inDays(2), endsAt: inDays(2.1), myStatus: null,
};

function Dialog({ onCancelled }: { onCancelled: () => void }) {
  const [reason, setReason] = useState('');
  return <CancelClassDialog c={klass} reason={reason} onReason={setReason} onClose={() => {}} onCancelled={onCancelled} onStale={() => {}} />;
}

test('Enter in the reason field does not cancel the class; only the full hold does', async () => {
  vi.mocked(api).mockResolvedValue(undefined as never);
  const onCancelled = vi.fn();
  render(<Dialog onCancelled={onCancelled} />);
  // Typing the reason and pressing Enter out of habit must not skip the hold.
  await userEvent.setup().type(screen.getByLabelText(/Reason/), 'Instructor out sick{Enter}');
  expect(api).not.toHaveBeenCalled();
  expect(onCancelled).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button', { name: /Hold to cancel class/ }), { key: ' ' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); });
  expect(api).toHaveBeenCalledWith('/classes/5/cancel', { method: 'POST', body: { expectedRevision: 4, reason: 'Instructor out sick' } });
  expect(onCancelled).toHaveBeenCalledTimes(1);
});
