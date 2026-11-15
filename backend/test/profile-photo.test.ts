import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/domain.js";
import { PROFILE_PHOTO_MAX_BYTES, photoDataUrl, profilePhotoField } from "../src/profilePhoto.js";
import { dataUrl, jpeg, webpExtended, webpLossless, webpLossy } from "./helpers/photos.js";

const rejects = (value: unknown, pattern: RegExp) =>
  assert.throws(() => profilePhotoField(value), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_PHOTO");
    assert.equal(error.field, "image");
    assert.match(error.message, pattern);
    return true;
  });

// The browser editor sends JPEG or WebP (lossy, lossless, or extended when it has transparency).
test("profile photos accept the JPEG and WebP forms browsers encode", () => {
  for (const [type, bytes] of [
    ["image/jpeg", jpeg(256, 256)],
    ["image/webp", webpLossy(256, 256)],
    ["image/webp", webpLossless(256, 256)],
    ["image/webp", webpExtended(256, 256)],
    ["image/jpeg", jpeg(32, 1024)],
  ] as const) {
    const photo = profilePhotoField(dataUrl(type, bytes));
    assert.equal(photo.contentType, type);
    assert.deepEqual(photo.image, bytes);
    assert.match(photo.version, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(photoDataUrl(photo), dataUrl(type, bytes));
  }
});

// Versions let the browser tell a changed photo from the one it already has.
test("a photo's version follows its content", () => {
  const first = profilePhotoField(dataUrl("image/jpeg", jpeg(256, 256)));
  assert.equal(profilePhotoField(dataUrl("image/jpeg", jpeg(256, 256))).version, first.version);
  assert.notEqual(profilePhotoField(dataUrl("image/jpeg", jpeg(256, 255))).version, first.version);
});

test("profile photos reject anything that is not a bounded JPEG or WebP", () => {
  for (const value of [undefined, null, 42, {}, ""]) rejects(value, /Choose a photo/);
  // Other formats, including SVG, which can carry script.
  rejects(dataUrl("image/png", Buffer.from("89504e470d0a1a0a", "hex")), /JPEG or WebP/);
  rejects(dataUrl("image/svg+xml", Buffer.from("<svg onload=alert(1)>")), /JPEG or WebP/);
  rejects(`https://example.com/photo.jpg`, /JPEG or WebP/);
  // Base64 that isn't canonical: whitespace, wrong padding.
  const encoded = jpeg(256, 256).toString("base64");
  rejects(`data:image/jpeg;base64,${encoded.slice(0, 20)} ${encoded.slice(20)}`, /JPEG or WebP/);
  rejects(`data:image/jpeg;base64,${encoded}A`, /JPEG or WebP/);
  // The bytes have to be the format the label claims, and nothing more.
  rejects(dataUrl("image/webp", jpeg(256, 256)), /readable/);
  rejects(dataUrl("image/jpeg", webpLossy(256, 256)), /readable/);
  rejects(dataUrl("image/jpeg", Buffer.concat([jpeg(256, 256), Buffer.from("<html>")])), /readable/);
  rejects(dataUrl("image/webp", Buffer.concat([webpLossy(256, 256), Buffer.from("PK\u0003\u0004")])), /readable/);
  rejects(dataUrl("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])), /readable/);
  rejects(dataUrl("image/webp", webpExtended(256, 256, 0x12)), /readable/); // animated
  // Size and dimension bounds.
  rejects(dataUrl("image/jpeg", jpeg(256, 256, Buffer.alloc(PROFILE_PHOTO_MAX_BYTES - 40))), /too large/);
  rejects(`data:image/jpeg;base64,${"A".repeat(200_000)}`, /too large/);
  rejects(dataUrl("image/jpeg", jpeg(16, 256)), /between 32 and 1024/);
  rejects(dataUrl("image/webp", webpLossless(4000, 4000)), /between 32 and 1024/);
  rejects(dataUrl("image/jpeg", jpeg(256, 0)), /between 32 and 1024/);
});
