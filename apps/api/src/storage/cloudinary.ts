import { randomUUID } from 'node:crypto';
import { cloudinary } from '../config/cloudinary.js';
import { env } from '../config/env.js';
import { decryptBuffer, encryptBuffer, sha256Hex } from '../lib/crypto.js';
import { AppError, internal, notFound } from '../lib/errors.js';
import type { StorageDriver, StoredObject } from './types.js';

/**
 * Cloudinary evidence driver.
 *
 * Cloudinary is used here purely as a durable object store, NOT as an image CDN,
 * and that distinction is deliberate. Evidence attached to a harassment or
 * sexual-harassment report is special-category personal data; it must not be
 * transformable, thumbnailable, or fetchable by URL. So:
 *
 *   • bytes are AES-256-GCM encrypted before upload — Cloudinary stores opaque
 *     ciphertext and cannot read, index, or transform the image;
 *   • the asset is uploaded as `resource_type: 'raw'` with `type: 'private'`, so
 *     no public delivery URL exists for it at all;
 *   • `public_id` is a random UUID, so nothing is guessable from a report id;
 *   • retrieval happens server-side through a short-lived signed URL, and the
 *     plaintext is only ever streamed to a party the app has authorised and
 *     audited.
 *
 * Losing CDN transformations is the correct trade here: a cached public thumbnail
 * of someone's evidence is precisely the failure mode this platform exists to
 * prevent.
 */

/** Signed URLs live only as long as the server needs to pull the bytes. */
const SIGNED_URL_TTL_SECONDS = 60;

export class CloudinaryStorageDriver implements StorageDriver {
  readonly name = 'cloudinary' as const;

  async put(plaintext: Buffer): Promise<StoredObject> {
    const { ciphertext, iv, authTag } = encryptBuffer(plaintext);
    const publicId = `${env.CLOUDINARY_EVIDENCE_FOLDER}/${randomUUID().replace(/-/g, '')}`;

    const key = await new Promise<string>((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: 'raw',
          // No public delivery URL is ever generated for a private asset.
          type: 'private',
          overwrite: false,
        },
        (error, result) => {
          if (error) {
            reject(internal('Could not store the uploaded file.', error));
            return;
          }
          if (!result?.public_id) {
            reject(internal('Storage returned no identifier for the upload.'));
            return;
          }
          resolve(result.public_id);
        },
      );
      upload.end(ciphertext);
    });

    return {
      key,
      contentHash: sha256Hex(plaintext),
      sizeBytes: plaintext.byteLength,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  async get(object: Pick<StoredObject, 'key' | 'iv' | 'authTag'>): Promise<Buffer> {
    // A private raw asset has no public URL; this mints a signed, expiring one
    // that only this process uses, for the duration of this request.
    const signedUrl = cloudinary.utils.private_download_url(object.key, '', {
      resource_type: 'raw',
      type: 'private',
      expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS,
    });

    let ciphertext: Buffer;
    try {
      const response = await fetch(signedUrl);
      if (response.status === 404) throw notFound('That file is no longer available.');
      if (!response.ok) {
        throw internal(`Storage responded ${response.status} when fetching evidence.`);
      }
      ciphertext = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      // Preserve a deliberate AppError; wrap anything else (DNS, TLS, timeouts).
      if (err instanceof AppError) throw err;
      throw internal('Could not retrieve the stored file.', err);
    }

    try {
      return decryptBuffer({
        ciphertext,
        iv: Buffer.from(object.iv, 'base64'),
        authTag: Buffer.from(object.authTag, 'base64'),
      });
    } catch (err) {
      // GCM auth failure: the ciphertext was altered in transit or at rest.
      throw internal('Stored evidence failed its integrity check.', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(key, { resource_type: 'raw', type: 'private' });
    } catch {
      /* deletion is idempotent — a missing asset is already in the desired state */
    }
  }
}
