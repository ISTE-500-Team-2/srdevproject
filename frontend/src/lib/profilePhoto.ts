// Profile photos: loading the signed-in account's photo once per version, and turning a chosen
// image file into the small square photo the API stores. The server re-checks every upload.

import { useEffect, useState } from "react";
import { api } from "./api";

export interface StoredPhoto {
  version: string;
  image: string;
}
/** A decoded image ready to draw. */
export interface PhotoSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}
/** How the photo sits in its circle. `x` and `y` move the photo's centre, in frame widths. */
export interface Crop {
  zoom: number;
  x: number;
  y: number;
}

/** A problem preparing a photo in the browser, worded for the person choosing it. */
export class PhotoError extends Error {}

/** Edge length of a stored photo: sharp in the largest avatar (84px) on a 3x screen. */
export const PHOTO_SIZE = 256;
export const MAX_ZOOM = 4;
/** The API stores at most 64 KiB. */
const MAX_BYTES = 64 * 1024;
/** Larger files are almost certainly not a photo someone means to crop to 256px. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Each photo version is fetched once per page load and kept for the next avatar that shows it.
const ready = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
function keep(photo: StoredPhoto) {
  ready.delete(photo.version);
  ready.set(photo.version, photo.image);
  while (ready.size > 8) ready.delete(ready.keys().next().value!);
}

/** Remember a photo this page just saved, so its avatars need no request. */
export const rememberPhoto = keep;
/** Bumped on sign-out: a photo asked for before then is dropped when it arrives, never kept. */
let generation = 0;
/** Drop loaded photos when someone signs out, so the next person's session starts empty. */
export function forgetPhotos() {
  generation++;
  ready.clear();
  pending.clear();
  memberReady.clear();
  memberPending.clear();
  // Requests not sent yet never will be: they settle now, with initials.
  const waiting = queued;
  queued = new Map();
  for (const list of waiting.values()) for (const waiter of list) waiter.settle(null);
}

// Staff screens show other members' photos. Requests made together (a list rendering) are sent as
// one `/admin/photos` call per 50 members, and each member's photo is kept by version.
const memberReady = new Map<string, string>();
const memberPending = new Map<string, Promise<string | null>>();
let queued = new Map<number, { version: string; settle: (image: string | null) => void }[]>();
const BATCH = 50;

function keepMember(id: number, photo: StoredPhoto) {
  const key = `${id}:${photo.version}`;
  memberReady.delete(key);
  memberReady.set(key, photo.image);
  while (memberReady.size > 300) memberReady.delete(memberReady.keys().next().value!);
}

function sendQueued() {
  const batch = queued;
  queued = new Map();
  const ids = [...batch.keys()];
  const asked = generation;
  for (let at = 0; at < ids.length; at += BATCH) {
    const chunk = ids.slice(at, at + BATCH);
    const settle = (answer: Record<string, StoredPhoto> | null) => {
      // Someone signed out while this was on its way: show initials and keep nothing.
      const found = asked === generation ? answer : null;
      for (const id of chunk) {
        const photo = found?.[id];
        if (photo) keepMember(id, photo);
        // A list read before the member changed their photo gets initials, not the new photo.
        for (const waiter of batch.get(id) ?? []) waiter.settle(photo?.version === waiter.version ? photo.image : null);
      }
    };
    api<Record<string, StoredPhoto>>(`/admin/photos?ids=${chunk.join(",")}`).then(settle, () => settle(null));
  }
}

/** The image for `version` of member `id`'s photo, or null when the server has another (or none). */
export function loadMemberPhoto(id: number, version: string): Promise<string | null> {
  const key = `${id}:${version}`;
  const image = memberReady.get(key);
  if (image) return Promise.resolve(image);
  let request = memberPending.get(key);
  if (!request) {
    const queuedRequest: Promise<string | null> = new Promise<string | null>((settle) => {
      if (!queued.size) setTimeout(sendQueued, 0);
      queued.set(id, [...(queued.get(id) ?? []), { version, settle }]);
    }).finally(() => {
      if (memberPending.get(key) === queuedRequest) memberPending.delete(key);
    });
    request = queuedRequest;
    memberPending.set(key, request);
  }
  return request;
}

/** Member `id`'s photo for staff screens, once loaded; null shows the initials instead. */
export function useMemberPhoto(id: number | null | undefined, version: string | null | undefined): string | null {
  const key = id && version ? `${id}:${version}` : null;
  const [loaded, setLoaded] = useState<{ key: string; image: string | null } | null>(null);
  useEffect(() => {
    if (!id || !version || memberReady.has(`${id}:${version}`)) return;
    let live = true;
    const settle = (image: string | null) => {
      if (live) setLoaded({ key: `${id}:${version}`, image });
    };
    loadMemberPhoto(id, version).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [id, version]);
  if (!key) return null;
  return memberReady.get(key) ?? (loaded?.key === key ? loaded.image : null);
}

/**
 * The image for `version` of the photo of `account`, the account this session is showing, or null
 * when the server now has another photo (or none). `/me/photo` answers for whichever account the
 * session shows when it arrives (an opened member's during account mode), so a different version
 * is never shown in its place, and a request made for one account is never reused for another.
 */
export function loadPhoto(version: string, account: number): Promise<string | null> {
  const image = ready.get(version);
  if (image) return Promise.resolve(image);
  const key = `${account}:${version}`;
  let request = pending.get(key);
  if (!request) {
    const asked = generation;
    const sent: Promise<string | null> = api<StoredPhoto | null>("/me/photo")
      .then((photo) => {
        // Someone signed out while this was on its way: keep nothing.
        if (asked !== generation) return null;
        if (photo) keep(photo);
        return photo?.version === version ? photo.image : null;
      })
      .finally(() => {
        if (pending.get(key) === sent) pending.delete(key);
      });
    request = sent;
    pending.set(key, request);
  }
  return request;
}

/**
 * The photo to show for `version` of `account`'s photo, once loaded; null shows the initials
 * instead. A different account (account mode opening or closing) asks again.
 */
export function useProfilePhoto(version: string | null | undefined, account: number | undefined): string | null {
  const [loaded, setLoaded] = useState<{ key: string; image: string | null } | null>(null);
  const key = version && account ? `${account}:${version}` : null;
  useEffect(() => {
    if (!version || !account || ready.has(version)) return;
    let live = true;
    const settle = (image: string | null) => {
      if (live) setLoaded({ key: `${account}:${version}`, image });
    };
    loadPhoto(version, account).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [version, account]);
  if (!version || !key) return null;
  return ready.get(version) ?? (loaded?.key === key ? loaded.image : null);
}

const clamp = (value: number, limit: number) => Math.min(Math.max(value, -limit), limit);

/** Keep the zoom in range and the photo covering the whole frame. */
export function clampCrop(width: number, height: number, crop: Crop): Crop {
  const zoom = Math.min(Math.max(crop.zoom, 1), MAX_ZOOM);
  const scale = zoom / Math.min(width, height);
  return {
    zoom,
    x: clamp(crop.x, (width * scale - 1) / 2),
    y: clamp(crop.y, (height * scale - 1) / 2),
  };
}

/** Zoom about the frame's centre, so the part of the photo there stays put. */
export function zoomCrop(width: number, height: number, crop: Crop, zoom: number): Crop {
  const next = Math.min(Math.max(zoom, 1), MAX_ZOOM);
  const factor = next / crop.zoom;
  return clampCrop(width, height, { zoom: next, x: crop.x * factor, y: crop.y * factor });
}

/** Where the photo is drawn in a square frame of `size` pixels: filling it at zoom 1. */
export function placement(width: number, height: number, size: number, crop: Crop) {
  const { zoom, x, y } = clampCrop(width, height, crop);
  const scale = (size / Math.min(width, height)) * zoom;
  return {
    x: (size - width * scale) / 2 + x * size,
    y: (size - height * scale) / 2 + y * size,
    width: width * scale,
    height: height * scale,
  };
}

/** Paint the cropped photo over white, which also fills any transparency. */
export function drawPhoto(context: CanvasRenderingContext2D, source: PhotoSource, size: number, crop: Crop) {
  const at = placement(source.width, source.height, size, crop);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source.image, at.x, at.y, at.width, at.height);
}

/** Decoded size of a base64 data URL. */
export function dataUrlBytes(url: string) {
  const data = url.slice(url.indexOf(",") + 1);
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * The cropped photo as the data URL the API accepts: WebP where the browser can encode it,
 * otherwise JPEG, at the best quality that fits the size limit.
 */
export function encodePhoto(source: PhotoSource, crop: Crop): string {
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new PhotoError("This browser can't edit photos. Try another browser.");
  drawPhoto(context, source, PHOTO_SIZE, crop);
  // Browsers that can't write WebP return a PNG instead.
  const type = canvas.toDataURL("image/webp", 0.5).startsWith("data:image/webp;") ? "image/webp" : "image/jpeg";
  for (const quality of [0.86, 0.72, 0.58, 0.44]) {
    const url = canvas.toDataURL(type, quality);
    if (dataUrlBytes(url) <= MAX_BYTES) return url;
  }
  throw new PhotoError("That photo has too much detail to save. Try another one.");
}

/** Decode a chosen file. Browsers apply the camera's rotation when decoding. */
export async function readPhotoFile(file: File): Promise<PhotoSource> {
  if (!file.type.startsWith("image/")) throw new PhotoError("Choose an image file, such as a JPEG or PNG photo.");
  if (file.size > MAX_FILE_BYTES) throw new PhotoError("That file is over 25 MB. Choose a smaller photo.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("empty image");
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    throw new PhotoError("That image couldn't be opened. Try a JPEG, PNG or WebP photo.");
  } finally {
    // The decoded image keeps its pixels; the file URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}
