import { LocalDiskStorage, VercelBlobStorage, storageForEnvironment } from './storage';

/**
 * Which adapter runs is decided by one environment variable, and getting it
 * wrong is silent in the worst direction: local disk on Vercel writes happily
 * into a filesystem that is discarded at the next deploy, so uploads appear to
 * work and the images are gone by morning.
 */
describe('storageForEnvironment', () => {
  const original = process.env.BLOB_READ_WRITE_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = original;
  });

  it('uses local disk when no blob store is attached', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(storageForEnvironment()).toBeInstanceOf(LocalDiskStorage);
  });

  it('uses the blob store as soon as a token is present', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_example';
    expect(storageForEnvironment()).toBeInstanceOf(VercelBlobStorage);
  });

  it('treats an empty token as no token, not as a blob store', () => {
    // An env var set to "" is what an unfilled Vercel field produces, and
    // choosing the blob adapter then fails on every upload instead of falling
    // back to something that works.
    process.env.BLOB_READ_WRITE_TOKEN = '';
    expect(storageForEnvironment()).toBeInstanceOf(LocalDiskStorage);
  });
});

describe('LocalDiskStorage path safety', () => {
  it('still refuses a key that escapes the upload directory', () => {
    // The traversal guard predates this change and must survive it.
    const storage = new LocalDiskStorage();
    return expect(storage.get('../../../etc/passwd')).rejects.toThrow(/escapes/);
  });
});
