// Catalog images are public product pictures, unlike private member profile photos. Uploads use
// the same bounded JPEG/WebP validation and are committed with the equipment record.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppError } from './domain.js';
import type { ProfilePhotoType } from './profilePhoto.js';

export const stockEquipmentImages = [
  { path: '/assets/3d-printer.webp', label: '3D printer' },
  { path: '/assets/laser-engraver.webp', label: 'Laser engraver' },
  { path: '/assets/cnc-machine.webp', label: 'CNC machine' },
  { path: '/assets/wood-lathe.webp', label: 'Lathe' },
];

export function equipmentImage(pool: Pool, kind: 'equipment' | 'class' = 'equipment') {
  return async (req: Request, res: Response) => {
    const version = req.params.version;
    if (typeof version !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(version))
      throw new AppError(404, 'NOT_FOUND', 'Catalog image not found.');
    const photo = (await pool.query<{ contentType: ProfilePhotoType; image: Buffer }>(
      `SELECT content_type AS "contentType", image FROM app_${kind}_image WHERE version=$1`, [version],
    )).rows[0];
    if (!photo) throw new AppError(404, 'NOT_FOUND', 'Catalog image not found.');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(photo.contentType).send(photo.image);
  };
}
