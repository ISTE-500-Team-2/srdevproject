// Vendored from React Bits (reactbits.dev, MIT). Icons swapped to lucide-react.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import './HoldButton.css';

const TAP_MS = 250;
// A press that isn't a hold (a screen reader, voice control or switch click, or a quick tap or key press)
// asks for a second press instead. The second must come a moment later, so a double click can't confirm,
// and within a window long enough for someone scanning with a switch to come back to the button. When the
// window lapses, the status says so.
const CONFIRM_GUARD_MS = 500;
const CONFIRM_WINDOW_MS = 30000;
const CONFIRM_LABEL = 'Press again to confirm';
const LAPSED_LABEL = 'Not confirmed in time. Nothing was changed.';
// A click this soon after the button's own pointer or key events comes from them, and they handled it.
const OWN_CLICK_MS = 1000;
const HIT_PAD = 10;
const LINEAR = t => t;
const EASE_OUT = t => 1 - Math.pow(1 - t, 3);

/**
 * Run the hold/cancel/complete gesture lifecycle. onHold runs after a completed hold, or after two
 * separate presses for people who can't hold (assistive technology activates with a single click);
 * onTap also hears each quick tap.
 */
export default function HoldButton({
  children = 'Hold to delete',
  doneLabel = 'Deleted',
  icon = null,
  doneIcon = null,
  backgroundColor = '#27272a',
  fillColor = '#5227FF',
  textColor = '#f5f5f5',
  fillTextColor = '#ffffff',
  size = 'md',
  radius = 14,
  fillDirection = 'right',
  holdTime = 2000,
  releaseTime = 200,
  pressScale = 0.97,
  wave = true,
  waveAmplitude = 6,
  glow = true,
  resetAfter = 1200,
  disabled = false,
  onHold,
  onTap,
  className = ''
}) {
  const [phase, setPhase] = useState('idle');
  const [input, setInput] = useState(null);
  const [lapsed, setLapsed] = useState(false);
  const phaseRef = useRef('idle');
  const inputRef = useRef(null);
  const buttonRef = useRef(null);
  const gesture = useRef({ pointerId: null, start: 0, rect: null });
  const timers = useRef({ complete: 0, reset: 0, disarm: 0 });
  // When the confirm step began, or null when the button isn't asking for a second press.
  const armedAt = useRef(null);
  // When the button's own pointer or key handlers last saw an event.
  const ownInputAt = useRef(-Infinity);
  const noteInput = () => {
    ownInputAt.current = performance.now();
  };
  const hintId = useId();

  const go = (next, kind = null) => {
    phaseRef.current = next;
    inputRef.current = kind;
    setPhase(next);
    setInput(kind);
    setLapsed(false);
  };

  const clearTimers = () => {
    clearTimeout(timers.current.complete);
    clearTimeout(timers.current.reset);
  };

  const motion = useRef({ raf: 0, p: 0, from: 0, to: 0, start: 0 });
  const drive = (to, duration, ease) => {
    const m = motion.current;
    cancelAnimationFrame(m.raf);
    m.from = m.p;
    m.to = to;
    m.start = performance.now();
    const step = now => {
      const t = duration > 0 ? Math.min(1, (now - m.start) / duration) : 1;
      m.p = m.from + (m.to - m.from) * ease(t);
      buttonRef.current?.style.setProperty('--hb-p', m.p.toFixed(4));
      if (t < 1) {
        m.raf = requestAnimationFrame(step);
        return;
      }
      m.raf = 0;
      if (m.to === 1) complete();
    };
    m.raf = requestAnimationFrame(step);
  };

  const disarm = () => {
    clearTimeout(timers.current.disarm);
    armedAt.current = null;
    if (phaseRef.current === 'confirm') go('idle');
  };

  const lapse = () => {
    const asking = phaseRef.current === 'confirm';
    disarm();
    if (asking) setLapsed(true);
  };

  const finish = () => {
    clearTimers();
    clearTimeout(timers.current.disarm);
    armedAt.current = null;
    go('done', inputRef.current);
    onHold?.();
    if (resetAfter > 0) {
      timers.current.reset = setTimeout(() => {
        go('idle');
        drive(0, releaseTime, EASE_OUT);
      }, resetAfter);
    }
  };

  const complete = () => {
    if (phaseRef.current !== 'holding') return;
    if (performance.now() - gesture.current.start < holdTime - 50) return;
    finish();
  };

  // A single press made at `at`: the first asks for confirmation, a later one confirms.
  const press = at => {
    if (disabled || (phaseRef.current !== 'idle' && phaseRef.current !== 'confirm')) return;
    if (armedAt.current !== null && at - armedAt.current >= CONFIRM_GUARD_MS) {
      drive(1, releaseTime, EASE_OUT);
      finish();
      return;
    }
    if (armedAt.current === null) {
      armedAt.current = performance.now();
      timers.current.disarm = setTimeout(lapse, CONFIRM_WINDOW_MS);
    }
    go('confirm');
  };

  const begin = kind => {
    const phase = phaseRef.current;
    if (disabled || (phase !== 'idle' && phase !== 'confirm')) return false;
    const button = buttonRef.current;
    if (!button) return false;
    gesture.current.start = performance.now();
    gesture.current.rect = button.getBoundingClientRect();
    go('holding', kind);
    drive(1, holdTime, LINEAR);
    timers.current.complete = setTimeout(complete, holdTime + 100);
    return true;
  };

  const release = ({ drifted = false } = {}) => {
    if (phaseRef.current !== 'holding') return;
    clearTimers();
    const held = performance.now() - gesture.current.start;
    if (drifted) disarm();
    go(armedAt.current === null ? 'idle' : 'confirm');
    drive(0, releaseTime, EASE_OUT);
    if (!drifted && held < TAP_MS) {
      onTap?.();
      press(gesture.current.start);
    }
  };
  const releaseRef = useRef(release);
  releaseRef.current = release;

  const handlePointerDown = e => {
    noteInput();
    if (e.button !== 0 || !e.isPrimary || gesture.current.pointerId !== null) return;
    if (!begin('pointer')) return;
    gesture.current.pointerId = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const endPointer = (e, options) => {
    if (e.pointerId !== gesture.current.pointerId) return;
    gesture.current.pointerId = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    release(options);
  };

  const handlePointerMove = e => {
    if (e.pointerId !== gesture.current.pointerId) return;
    const r = gesture.current.rect;
    if (!r) return;
    const out =
      e.clientX < r.left - HIT_PAD ||
      e.clientX > r.right + HIT_PAD ||
      e.clientY < r.top - HIT_PAD ||
      e.clientY > r.bottom + HIT_PAD;
    if (out) endPointer(e, { drifted: true });
  };

  const handlePointerLeave = e => {
    if (e.pointerType !== 'touch') endPointer(e, { drifted: true });
  };

  const handleKeyDown = e => {
    if (e.key === 'Escape') {
      if (inputRef.current === 'key') release({ drifted: true });
      else disarm();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      noteInput();
      e.preventDefault();
      if (!e.repeat) begin('key');
    }
  };

  const handleKeyUp = e => {
    if (e.key === ' ' || e.key === 'Enter') {
      noteInput();
      e.preventDefault();
      if (inputRef.current === 'key') release();
    }
  };

  // Pointer and key presses arrive through the handlers above, which already dealt with the click that ends
  // them. Any other click is assistive technology activating the button, and it can't hold. Its detail isn't
  // a reliable sign: Firefox's accessibility click, for one, reports 1 like a mouse.
  const handleClick = () => {
    const now = performance.now();
    if (now - ownInputAt.current < OWN_CLICK_MS) return;
    press(now);
  };

  const handleBlur = () => {
    if (phaseRef.current === 'confirm') disarm();
  };

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    const measure = () => {
      button.style.setProperty('--hb-w', `${button.offsetWidth}px`);
      button.style.setProperty('--hb-h', `${button.offsetHeight}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(button);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (phase !== 'holding') return undefined;
    const cancel = () => releaseRef.current({ drifted: true });
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phase]);

  useEffect(() => {
    if (disabled) disarm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  useEffect(() => {
    const t = timers.current;
    const m = motion.current;
    return () => {
      clearTimeout(t.complete);
      clearTimeout(t.reset);
      clearTimeout(t.disarm);
      cancelAnimationFrame(m.raf);
    };
  }, []);

  const direction = fillDirection === 'up' ? 'up' : 'right';
  const labels = (
    <>
      <span className="hold-button__idle" aria-hidden={phase === 'done'}>
        {icon ? <span className="hold-button__icon">{icon}</span> : null}
        {phase === 'confirm' ? CONFIRM_LABEL : children}
      </span>
      <span className="hold-button__done" aria-hidden={phase !== 'done'}>
        {doneIcon ? <span className="hold-button__icon">{doneIcon}</span> : null}
        {doneLabel}
      </span>
    </>
  );

  return (
    <>
      {/* Outside the button, whose content is its name: a live region in there isn't reliably announced. */}
      <span className="hold-button__sr" role="status">
        {phase === 'confirm' ? CONFIRM_LABEL : lapsed ? LAPSED_LABEL : ''}
      </span>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        className={`hold-button hold-button--${size}${className ? ` ${className}` : ''}`}
        data-phase={phase}
        data-input={input ?? undefined}
        data-direction={direction}
        data-glow={glow ? 'true' : undefined}
        aria-describedby={hintId}
        style={{
          '--hb-radius': `${radius}px`,
          '--hb-bg': backgroundColor,
          '--hb-fill': fillColor,
          '--hb-text': textColor,
          '--hb-fill-text': fillTextColor,
          '--hb-hold': `${holdTime}ms`,
          '--hb-cycles': holdTime / 1100,
          '--hb-release': `${releaseTime}ms`,
          '--hb-press': pressScale,
          '--hb-wave': `${wave ? waveAmplitude : 0}px`
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={e => {
          noteInput();
          endPointer(e);
        }}
        onPointerCancel={e => endPointer(e, { drifted: true })}
        onLostPointerCapture={e => endPointer(e, { drifted: true })}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleClick}
        onBlur={handleBlur}
        onContextMenu={e => e.preventDefault()}
      >
        <span className="hold-button__pulse" aria-hidden="true" />
        <span className="hold-button__label">{labels}</span>
        <span className="hold-button__clip" aria-hidden="true">
          <span className="hold-button__fill">
            <span className="hold-button__label hold-button__label--fill">{labels}</span>
          </span>
          <span className="hold-button__crest" aria-hidden="true">
            <span className="hold-button__label hold-button__label--fill">{labels}</span>
          </span>
        </span>
        <span id={hintId} className="hold-button__sr">
          Press and hold for {Math.round(holdTime / 100) / 10} seconds, or press twice, to confirm
        </span>
      </button>
    </>
  );
}
