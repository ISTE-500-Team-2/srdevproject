import { dataUrlBytes, readPhotoFile } from './profilePhoto';

/** Re-encode uploads without cropping the machine; fit the API's bounded image format. */
export async function prepareEquipmentImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('Choose a JPEG, PNG or WebP image.');
  const source = await readPhotoFile(file);
  if (Math.min(source.width, source.height) < 32)
    throw new Error('Choose an image at least 32 pixels wide and tall.');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot prepare images. Try another browser.');
  // Very narrow panoramas keep their aspect ratio and still meet the server's minimum side.
  for (const maxSide of [1024, 768, 512]) {
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    if (Math.min(canvas.width, canvas.height) < 32) continue;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    const type = canvas.toDataURL('image/webp', 0.5).startsWith('data:image/webp;') ? 'image/webp' : 'image/jpeg';
    for (const quality of [0.86, 0.72, 0.58, 0.44]) {
      const data = canvas.toDataURL(type, quality);
      if (dataUrlBytes(data) <= 64 * 1024) return data;
    }
  }
  throw new Error('This image could not be resized for the catalog. Try a smaller or less panoramic image.');
}
