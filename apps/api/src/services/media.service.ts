import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { cloudinary, hasCloudinary } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { badRequest, internal, preconditionFailed } from '../lib/errors.js';

/**
 * Public image uploads (avatars).
 *
 * This is Cloudinary used the way Cloudinary is meant to be used: real image
 * uploads, CDN delivery, server-side transformation. It is deliberately a
 * *separate* path from evidence storage, because the two have opposite
 * requirements — an avatar should be cacheable and public, and evidence must be
 * neither. Keeping them in different modules with different folders means no
 * future edit can quietly route evidence down the public path.
 *
 * Safety measures applied to every upload:
 *   • magic-byte type check, so `avatar.png` really is an image;
 *   • a forced re-encode to a fixed 512×512 crop, which strips EXIF — including
 *     the GPS coordinates phone cameras attach. On a safety platform, leaking a
 *     user's home location through their profile picture is a real harm.
 */

const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

export interface UploadedImage {
  /** Public CDN URL, safe to store and render. */
  url: string;
  /** Cloudinary public_id, needed to replace or delete the asset later. */
  publicId: string;
  width: number;
  height: number;
}

export async function uploadAvatar(params: {
  userId: string;
  buffer: Buffer;
}): Promise<UploadedImage> {
  if (!hasCloudinary) {
    throw preconditionFailed('Image uploads are not configured on this server.');
  }
  if (params.buffer.byteLength === 0) throw badRequest('That file is empty.');
  if (params.buffer.byteLength > MAX_AVATAR_BYTES) {
    throw badRequest('Profile pictures must be 5 MB or smaller.');
  }

  const sniffed = await fileTypeFromBuffer(params.buffer);
  if (!sniffed || !(AVATAR_MIME as readonly string[]).includes(sniffed.mime)) {
    throw badRequest('Profile pictures must be a JPEG, PNG, or WebP image.');
  }

  // Random public_id: deriving it from the user id would let anyone holding a
  // user id guess the avatar URL and confirm the account exists.
  const publicId = `${env.CLOUDINARY_AVATAR_FOLDER}/${randomUUID().replace(/-/g, '')}`;

  return new Promise<UploadedImage>((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: 'image',
        // Re-encoding to webp at a fixed size discards all original metadata.
        transformation: [
          { width: 512, height: 512, crop: 'fill', gravity: 'auto' },
          { fetch_format: 'webp', quality: 'auto' },
        ],
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          reject(internal('Could not upload that image.', error));
          return;
        }
        if (!result?.secure_url) {
          reject(internal('Image upload returned no URL.'));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
        });
      },
    );
    upload.end(params.buffer);
  });
}

/** Remove a previously uploaded avatar. Idempotent. */
export async function deleteAvatar(publicId: string): Promise<void> {
  if (!hasCloudinary || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch {
    /* a missing asset is already in the desired state */
  }
}
