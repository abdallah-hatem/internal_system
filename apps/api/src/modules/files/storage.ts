import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Where the bytes live.
 *
 * An interface with one implementation, on purpose. Local disk is right for the
 * volumes here and needs no account, no bill and no network — but it ties the
 * app to a host with a real disk, and Vercel, Railway and Fly all wipe theirs on
 * every deploy. Moving to R2 or S3 later should be a second implementation and
 * a config value rather than a rewrite of everything that touches an image.
 *
 * `uploads/` is not in the database. It has to be added to the backup script, or
 * a `pg_dump` restore brings back every product with a broken image.
 */
export interface StorageAdapter {
  put(objectKey: string, bytes: Buffer): Promise<void>;
  get(objectKey: string): Promise<Buffer>;
  delete(objectKey: string): Promise<void>;
}

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

export class LocalDiskStorage implements StorageAdapter {
  async put(objectKey: string, bytes: Buffer): Promise<void> {
    const target = this.resolve(objectKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  async get(objectKey: string): Promise<Buffer> {
    return fs.readFile(this.resolve(objectKey));
  }

  async delete(objectKey: string): Promise<void> {
    await fs.rm(this.resolve(objectKey), { force: true });
  }

  /**
   * A path inside the upload directory, and nowhere else.
   *
   * Object keys are generated here, not supplied by callers — but a download
   * route takes one from the URL, and `../../../etc/passwd` resolves perfectly
   * well through `path.join`. Checked rather than trusted.
   */
  private resolve(objectKey: string): string {
    const target = path.resolve(UPLOAD_DIR, objectKey);
    if (target !== UPLOAD_DIR && !target.startsWith(UPLOAD_DIR + path.sep)) {
      throw new Error('object key escapes the upload directory');
    }
    return target;
  }
}

/**
 * Vercel Blob, for hosts without a disk that survives a deploy.
 *
 * The comment above turned out to be the deployment plan: Vercel wipes the
 * filesystem on every build, so on a serverless host `LocalDiskStorage` loses
 * every product photograph and every picture a shop attached to an import
 * request — silently, because writing still succeeds and only later reads fail.
 *
 * Object keys are unchanged. The same key that was a path under `uploads/` is a
 * pathname in the blob store, so nothing that stores or resolves a key had to
 * change, and a database written by one adapter is readable by the other.
 *
 * `addRandomSuffix: false` matters: with the default, Vercel appends random
 * characters to the pathname and the URL no longer matches the key the database
 * holds. `allowOverwrite` because re-uploading a processed size must replace it
 * rather than fail.
 */
export class VercelBlobStorage implements StorageAdapter {
  /**
   * Loaded lazily, not at module load.
   *
   * Nothing outside a Vercel deployment has a blob token, so a top-level import
   * would pull the package into every local run and every test for no reason.
   *
   * `require` is correct here despite the package being `"type": "module"`: it
   * ships a CommonJS build behind the `require` condition of its exports map,
   * and Node resolves that. Verified rather than assumed — `uuid` looked like
   * the same shape, was not, and took the API down in production while the
   * build reported success.
   */
  private get blob() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@vercel/blob');
  }

  async put(objectKey: string, bytes: Buffer): Promise<void> {
    // `private`, matching the store. These are product photographs and pictures
    // customers attached to import requests, and the app already serves every
    // one of them through an authenticated route. A public blob would hand out
    // a URL that works forever for anyone who sees it, quietly undoing that.
    await this.blob.put(objectKey, bytes, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

  async get(objectKey: string): Promise<Buffer> {
    // `get` rather than `fetch(url)`: a private blob's URL is not readable
    // without credentials, so a plain fetch returns 401 and the image renders
    // broken with nothing saying why. The SDK signs the request with the
    // store's token.
    //
    // `access` is required and is not inferred from the store — pass it wrong
    // and the read fails against a store holding the object perfectly well.
    const result = await this.blob.get(objectKey, { access: 'private' });
    if (!result) throw new Error(`no such object: ${objectKey}`);

    // It returns a stream and metadata, not a Response — there is no
    // `arrayBuffer()` on it. 304 carries no body, which cannot happen here
    // because nothing sends a conditional request, but it is in the type and
    // returning `Buffer.from(null)` would be a confusing way to find that out.
    if (result.statusCode !== 200 || !result.stream) {
      throw new Error(`unexpected ${result.statusCode} reading ${objectKey}`);
    }

    const chunks: Uint8Array[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async delete(objectKey: string): Promise<void> {
    // Deleting something that is already gone is not an error worth raising —
    // the caller wanted it absent and it is.
    await this.blob.del(objectKey).catch(() => undefined);
  }
}

/**
 * Which one to use, decided once.
 *
 * By the token rather than by NODE_ENV: `BLOB_READ_WRITE_TOKEN` is what Vercel
 * injects when a blob store is attached, so the app follows what it has been
 * given instead of guessing from the environment name. Running production
 * locally against a disk still works, and a Vercel deploy with no store
 * attached fails loudly on first upload rather than writing into a directory
 * that is about to disappear.
 */
export function storageForEnvironment(): StorageAdapter {
  return process.env.BLOB_READ_WRITE_TOKEN
    ? new VercelBlobStorage()
    : new LocalDiskStorage();
}
