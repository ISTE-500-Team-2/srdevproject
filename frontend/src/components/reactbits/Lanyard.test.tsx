// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import Lanyard from './Lanyard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Band() {
  const home = useRef<HTMLDivElement>(null);
  return (
    <div className="access-band">
      <button type="button">Accept</button>
      <div ref={home} />
      <Lanyard home={home} className="member-badge__stage" />
    </div>
  );
}

test('without WebGL, the badge stage still lets taps through to the band beneath it', () => {
  // No WebGL (iOS Lockdown Mode, hardware acceleration off): three.js cannot create a context and logs why.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(<Band />);
  const stage = container.querySelector<HTMLElement>('.member-badge__stage')!;
  expect(logged).toHaveBeenCalledWith(expect.stringContaining('Error creating WebGL context'));
  expect(stage.querySelector('canvas')).toBeNull();
  expect(stage.style.pointerEvents).toBe('none');
});
