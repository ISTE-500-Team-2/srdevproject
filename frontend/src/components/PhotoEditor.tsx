// Positions a chosen photo in the circle its avatar will show: drag or arrow keys move it, the
// slider (or + and -) zooms. What the circle shows is what gets saved.

import { Check, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampCrop, drawPhoto, MAX_ZOOM, zoomCrop, type Crop, type PhotoSource } from "../lib/profilePhoto";
import "./photoEditor.css";

/** Edge length of the on-screen frame, in CSS pixels. */
const FRAME = 240;

export function PhotoEditor({
  source,
  busy,
  error,
  onCancel,
  onSave,
}: {
  source: PhotoSource;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSave: (crop: Crop) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; from: Crop } | null>(null);
  const { width, height } = source;

  useEffect(() => {
    const frame = canvas.current;
    const context = frame?.getContext("2d");
    if (!frame || !context) return;
    const size = Math.round(FRAME * Math.min(window.devicePixelRatio || 1, 3));
    if (frame.width !== size) frame.width = frame.height = size;
    drawPhoto(context, source, size, crop);
  }, [source, crop]);

  const moveBy = (from: Crop, dx: number, dy: number) => clampCrop(width, height, { ...from, x: from.x + dx, y: from.y + dy });
  const zoomTo = (zoom: number) => setCrop((current) => zoomCrop(width, height, current, zoom));

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: crop };
  };
  const continueDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId) return;
    const size = event.currentTarget.getBoundingClientRect().width || FRAME;
    setCrop(moveBy(start.from, (event.clientX - start.x) / size, (event.clientY - start.y) / size));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key]!;
      setCrop((current) => moveBy(current, dx, dy));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(crop.zoom + 0.1);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomTo(crop.zoom - 0.1);
    }
  };

  return (
    <div className="photo-editor">
      <div
        className="photo-editor__frame"
        role="group"
        aria-label="Photo position. Drag the photo, or use the arrow keys, to move it in the circle. Plus and minus zoom."
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={nudge}
      >
        <canvas ref={canvas} aria-hidden="true" />
      </div>
      <label className="photo-editor__zoom">
        <ZoomOut aria-hidden="true" />
        <span className="sr-only">Zoom</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={crop.zoom}
          onChange={(event) => zoomTo(Number(event.target.value))}
          disabled={busy}
        />
        <ZoomIn aria-hidden="true" />
      </label>
      <p className="photo-editor__hint">Drag to reposition. The circle shows how your photo will look.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="photo-editor__actions">
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="button button--primary" onClick={() => onSave(crop)} disabled={busy}>
          <Check aria-hidden="true" /> {busy ? "Saving…" : "Save photo"}
        </button>
      </div>
    </div>
  );
}
