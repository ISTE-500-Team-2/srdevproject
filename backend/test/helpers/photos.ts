// Structurally valid image headers for profile photo tests. The server reads headers and sizes,
// never pixels, so these stand in for browser-encoded photos.

const riffChunk = (fourcc: string, data: Buffer) => {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
};
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
};

/** A baseline JPEG: start, JFIF header, frame header, optional filler and end markers. */
export function jpeg(width: number, height: number, filler = Buffer.alloc(0)) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    filler.length ? Buffer.concat([Buffer.from([0xff, 0xfe, (filler.length + 2) >> 8, (filler.length + 2) & 255]), filler]) : filler,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A lossy (VP8) WebP. */
export function webpLossy(width: number, height: number) {
  const data = Buffer.alloc(16);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return riff(riffChunk("VP8 ", data));
}

/** A lossless (VP8L) WebP. */
export function webpLossless(width: number, height: number) {
  const data = Buffer.alloc(16);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return riff(riffChunk("VP8L", data));
}

/** An extended (VP8X) WebP, as browsers write for photos with transparency. */
export function webpExtended(width: number, height: number, flags = 0x10) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff(riffChunk("VP8X", data), riffChunk("VP8 ", webpLossy(width, height).subarray(20)));
}

export const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
