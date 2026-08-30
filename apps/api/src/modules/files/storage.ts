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
