import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { decryptBuffer, encryptBuffer, sha256Hex } from '../lib/crypto.js';
import { internal, notFound } from '../lib/errors.js';
import type { StorageDriver, StoredObject } from './types.js';
import { CloudinaryStorageDriver } from './cloudinary.js';

/**
 * Evidence storage.
 *
 * Two rules hold across every driver (see ./types.ts):
 *   • bytes are encrypted with AES-256-GCM before they touch the backing store,
 *     so a leaked bucket or stolen disk yields ciphertext;
 *   • nothing is ever reachable by a predictable or user-supplied path — keys are
 *     random UUIDs, and retrieval goes through the application so it can be
 *     authorised and audited.
 *
 * Changing STORAGE_DRIVER between `local`, `s3`, and `cloudinary` changes only
 * where ciphertext lands.
 */

export type { StorageDriver, StoredObject } from './types.js';

/* ------------------------------------------------------------------- local */

class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(process.cwd(), dir);
  }

  /**
   * Fan keys out over two levels of subdirectory. A single flat directory with
   * tens of thousands of entries is slow to list and unpleasant on Windows.
   */
  private pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), key.slice(2, 4), key);
  }

  async put(plaintext: Buffer): Promise<StoredObject> {
    const key = randomUUID().replace(/-/g, '');
    const { ciphertext, iv, authTag } = encryptBuffer(plaintext);
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, ciphertext, { mode: 0o600 });
    return {
      key,
      contentHash: sha256Hex(plaintext),
      sizeBytes: plaintext.byteLength,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  async get(object: Pick<StoredObject, 'key' | 'iv' | 'authTag'>): Promise<Buffer> {
    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(this.pathFor(object.key));
    } catch {
      throw notFound('That file is no longer available.');
    }
    try {
      return decryptBuffer({
        ciphertext,
        iv: Buffer.from(object.iv, 'base64'),
        authTag: Buffer.from(object.authTag, 'base64'),
      });
    } catch (err) {
      // GCM auth failure means the file was tampered with or the key changed.
      // Either way this is not something to paper over.
      throw internal('Stored evidence failed its integrity check.', err);
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => {
      /* already gone — deletion is idempotent */
    });
  }
}

/* ---------------------------------------------------------------------- s3 */

class S3StorageDriver implements StorageDriver {
  readonly name = 's3' as const;
  async put(): Promise<StoredObject> {
    throw new Error('S3 driver not implemented yet — set STORAGE_DRIVER=local or cloudinary');
  }
  async get(): Promise<Buffer> {
    throw new Error('S3 driver not implemented yet — set STORAGE_DRIVER=local or cloudinary');
  }
  async delete(): Promise<void> {
    throw new Error('S3 driver not implemented yet — set STORAGE_DRIVER=local or cloudinary');
  }
}

/* ------------------------------------------------------------------ select */

function makeStorage(): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return new LocalStorageDriver(env.STORAGE_LOCAL_DIR);
    case 'cloudinary':
      return new CloudinaryStorageDriver();
    case 's3':
      return new S3StorageDriver();
    default: {
      // Exhaustiveness guard: a new driver in the enum must be wired here.
      const never: never = env.STORAGE_DRIVER;
      throw new Error(`Unknown STORAGE_DRIVER: ${String(never)}`);
    }
  }
}

export const storage: StorageDriver = makeStorage();
