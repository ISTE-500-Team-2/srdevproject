// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './Modal';
afterEach(cleanup);
test('modal escapes transformed page stacking context and keeps its controls interactive',()=>{
  const close=vi.fn();const confirm=vi.fn();
  const view=render(<div style={{transform:'translateY(0)'}}><Modal open title="Reserve equipment" onClose={close}><button onClick={confirm}>Confirm reservation</button></Modal></div>);
  const dialog=screen.getByRole('dialog');
  expect(view.container.contains(dialog)).toBe(false);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  fireEvent.click(screen.getByText('Confirm reservation'));expect(confirm).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(window,{key:'Escape'});expect(close).toHaveBeenCalledOnce();
});
test('closed modal leaves no body overlay or scroll lock',()=>{
  const view=render(<Modal open title="Booking" onClose={()=>{}}>Details</Modal>);
  expect(document.body.classList.contains('modal-open')).toBe(true);
  view.rerender(<Modal open={false} title="Booking" onClose={()=>{}}>Details</Modal>);
  expect(screen.queryByRole('dialog')).toBeNull();expect(document.body.classList.contains('modal-open')).toBe(false);
});
