// Validates profile photos sent as data URLs. The browser crops and re-encodes every photo, so the
// server accepts only the two formats browsers produce, checks the bytes really are that format and
// bounds both file size and pixel dimensions before anything is stored or shown to anyone.

import { createHash } from "node:crypto";
import { AppError } from "./domain.js";

/** Largest stored photo. Its base64 form still fits the API's 96 KB JSON body limit. */
export const PROFILE_PHOTO_MAX_BYTES = 64 * 1024;
/** Pixel bounds: small enough that a tiny file cannot decode into a huge bitmap. */
export const PROFILE_PHOTO_MIN_SIDE = 32;
export const PROFILE_PHOTO_MAX_SIDE = 1024;

export type ProfilePhotoType = "image/jpeg" | "image/webp";
export interface ProfilePhoto {
  contentType: ProfilePhotoType;
  image: Buffer;
  /** Content hash: the same photo always has the same version. */
  version: string;
}

const DATA_URL = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
// The longest data URL a photo within the byte limit can produce.
const MAX_DATA_URL_LENGTH = "data:image/webp;base64,".length + Math.ceil(PROFILE_PHOTO_MAX_BYTES / 3) * 4;

interface Size {
  width: number;
  height: number;
}

/**
 * A baseline or progressive JPEG's frame size, or null when the bytes aren't a complete JPEG.
 * Walks the marker segments to the first frame header; scan data before one is malformed.
 */
function jpegSize(bytes: Buffer): Size | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  // Browser encoders end at the end-of-image marker. Trailing bytes could carry another file.
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte before a marker
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(at + 2);
    if (length < 2) return null;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/** A still WebP's canvas size, or null when the bytes aren't one complete WebP file. */
function webpSize(bytes: Buffer): Size | null {
  if (bytes.length < 30) return null;
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  // The RIFF header states the file's length; anything after it could carry another file.
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  switch (bytes.toString("latin1", 12, 16)) {
    case "VP8 ":
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case "VP8L": {
      if (bytes[20] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X":
      // Animated photos aren't something the browser editor makes.
      if (bytes[20]! & 0x02) return null;
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** Parse a `data:image/jpeg|webp;base64,…` request value into a photo that is safe to store. */
export function profilePhotoField(value: unknown): ProfilePhoto {
  const invalid = (message: string) => new AppError(400, "INVALID_PHOTO", message, "image");
  if (typeof value !== "string" || !value) throw invalid("Choose a photo to upload.");
  if (value.length > MAX_DATA_URL_LENGTH) throw invalid("That photo is too large. Try a smaller one.");
  const match = DATA_URL.exec(value);
  if (!match || match[2]!.length % 4 !== 0) throw invalid("Upload a JPEG or WebP photo.");
  const contentType = match[1] as ProfilePhotoType;
  const image = Buffer.from(match[2]!, "base64");
  if (image.length > PROFILE_PHOTO_MAX_BYTES) throw invalid("That photo is too large. Try a smaller one.");
  const size = contentType === "image/jpeg" ? jpegSize(image) : webpSize(image);
  if (!size) throw invalid("That file isn't a readable JPEG or WebP photo.");
  if (
    size.width < PROFILE_PHOTO_MIN_SIDE || size.height < PROFILE_PHOTO_MIN_SIDE ||
    size.width > PROFILE_PHOTO_MAX_SIDE || size.height > PROFILE_PHOTO_MAX_SIDE
  )
    throw invalid(`Photos must be between ${PROFILE_PHOTO_MIN_SIDE} and ${PROFILE_PHOTO_MAX_SIDE} pixels on each side.`);
  const version = createHash("sha256").update(contentType).update(image).digest("base64url").slice(0, 22);
  return { contentType, image, version };
}

/** The stored photo as the data URL the browser shows. */
export const photoDataUrl = (photo: Pick<ProfilePhoto, "contentType" | "image">) =>
  `data:${photo.contentType};base64,${photo.image.toString("base64")}`;
