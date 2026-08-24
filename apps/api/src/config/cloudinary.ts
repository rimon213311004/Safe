import { v2 as cloudinary } from 'cloudinary';
import { env, hasCloudinary } from './env.js';

/**
 * Cloudinary is configured exactly once, here, from validated env. Two parts of
 * the app use it for very different purposes:
 *
 *   • storage/cloudinary.ts — evidence. Bytes are AES-256-GCM encrypted BEFORE
 *     upload and stored as a *private* `raw` asset, so Cloudinary only ever holds
 *     opaque ciphertext behind signed access. This preserves the platform rule
 *     that evidence is never reachable from a public URL.
 *
 *   • services/media.service.ts — avatars and other genuinely public images,
 *     uploaded and delivered normally over the CDN.
 *
 * `secure: true` forces https delivery URLs everywhere.
 */
if (hasCloudinary) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export { cloudinary, hasCloudinary };
