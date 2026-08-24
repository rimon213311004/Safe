/**
 * Storage driver contract.
 *
 * This lives apart from the driver implementations so each driver can import the
 * types without a cycle through the module that selects between them.
 *
 * Every driver upholds the same two invariants:
 *   • bytes are AES-256-GCM encrypted before they reach the backing store, so a
 *     leaked bucket, disk, or Cloudinary account yields only ciphertext;
 *   • objects are addressed by an opaque random key and are never reachable from
 *     a public or predictable URL — retrieval goes through the application so it
 *     can be authorised and audited.
 */

export type StorageDriverName = 'local' | 's3' | 'cloudinary';

export interface StoredObject {
  /** Opaque key within the driver. Never exposed to a client. */
  key: string;
  /** SHA-256 of the PLAINTEXT, for integrity checks and duplicate detection. */
  contentHash: string;
  sizeBytes: number;
  /** AES-256-GCM nonce, base64. */
  iv: string;
  /** AES-256-GCM authentication tag, base64. */
  authTag: string;
}

export interface StorageDriver {
  readonly name: StorageDriverName;
  put(plaintext: Buffer): Promise<StoredObject>;
  get(object: Pick<StoredObject, 'key' | 'iv' | 'authTag'>): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
