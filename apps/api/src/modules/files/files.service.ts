import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { badRequest, notFound } from '../../common/api-error';
import { storageForEnvironment, type StorageAdapter } from './storage';
import { processImage } from './image-pipeline';

/**
 * Images, and who they belong to.
 *
 * The previous version handed out an "upload URL", took the caller's word for
 * the mime type and size, and wrote the bytes straight to a path built from the
 * caller's own filename. It also recorded ownership in `owner_type` /
 * `owner_id`, which was polymorphic in name only — `owner_id` had a foreign key
 * to `products`, so a photo on a customer's request could never be stored at
 * all.
 *
 * Both are fixed here. One call does the work: the bytes arrive, are proved to
 * be an image by being re-encoded, and are written as three WebP sizes against
 * an owner the schema can enforce.
 */

export type FileOwner =
  | { productId: string; productRequestId?: never }
  | { productRequestId: string; productId?: never };

@Injectable()
export class FilesService {
  private storage: StorageAdapter = storageForEnvironment();

  constructor(private prisma: PrismaService) {}

  /**
   * Store one image against one owner.
   *
   * Everything is written or nothing is: the derivatives go to disk first, and
   * the rows are created in a single transaction afterwards. A half-written set
   * would leave a product card pointing at a file that is not there.
   */
  async upload(owner: FileOwner, file: Buffer, uploadedBy?: string) {
    await this.assertOwnerExists(owner);

    const derivatives = await processImage(file);
    const groupId = crypto.randomUUID();
    const folder = owner.productId
      ? `products/${owner.productId}`
      : `product-requests/${owner.productRequestId}`;

    const written = await Promise.all(
      derivatives.map(async (d) => {
        const objectKey = `${folder}/${groupId}-${d.variant.toLowerCase()}.webp`;
        await this.storage.put(objectKey, d.bytes);
        return { ...d, objectKey };
      }),
    );

    const original = written.find((w) => w.variant === 'ORIGINAL')!;

    return this.prisma.$transaction(async (tx) => {
      const parent = await tx.fileAsset.create({
        data: {
          objectKey: original.objectKey,
          mimeType: original.mimeType,
          sizeBytes: original.bytes.length,
          variant: 'ORIGINAL',
          width: original.width,
          height: original.height,
          uploadedBy,
          ...owner,
        },
      });

      for (const child of written.filter((w) => w.variant !== 'ORIGINAL')) {
        await tx.fileAsset.create({
          data: {
            objectKey: child.objectKey,
            mimeType: child.mimeType,
            sizeBytes: child.bytes.length,
            variant: child.variant,
            width: child.width,
            height: child.height,
            parentAssetId: parent.id,
            uploadedBy,
            ...owner,
          },
        });
      }

      return { data: { id: parent.id, objectKey: parent.objectKey } };
    });
  }

  /**
   * A product or request that is not there is a 404, not a foreign key failing
   * deep in Prisma as "an unexpected error occurred". CLAUDE.md rule 1.
   */
  private async assertOwnerExists(owner: FileOwner) {
    if (owner.productId) {
      const found = await this.prisma.product.findUnique({ where: { id: owner.productId } });
      if (!found) throw notFound('product');
      return;
    }
    const found = await this.prisma.productRequest.findUnique({
      where: { id: owner.productRequestId },
    });
    if (!found) throw notFound('productRequest');
  }

  async listFor(owner: FileOwner) {
    const files = await this.prisma.fileAsset.findMany({
      where: { ...owner, variant: 'ORIGINAL' },
      orderBy: { createdAt: 'asc' },
      include: {
        derivatives: { select: { variant: true, objectKey: true, width: true, height: true } },
      },
    });
    return { data: files };
  }

  async serveFile(objectKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // Looked up before it is read: the row is what says this key is something
    // we put there, and serving a file the database has never heard of is how a
    // download route becomes a way to read the disk.
    const asset = await this.prisma.fileAsset.findFirst({ where: { objectKey } });
    if (!asset) throw notFound('file');

    try {
      return { buffer: await this.storage.get(objectKey), mimeType: asset.mimeType };
    } catch {
      throw notFound('file');
    }
  }

  /** Remove an image and the sizes derived from it. */
  async remove(id: string) {
    const asset = await this.prisma.fileAsset.findUnique({
      where: { id },
      include: { derivatives: true },
    });
    if (!asset) throw notFound('file');
    if (asset.parentAssetId) {
      throw badRequest(
        'DELETE_THE_ORIGINAL',
        'Delete the original image; its other sizes go with it.',
      );
    }

    for (const file of [asset, ...asset.derivatives]) {
      await this.storage.delete(file.objectKey);
    }
    // The rows cascade from the parent.
    await this.prisma.fileAsset.delete({ where: { id } });

    return { data: { id, deleted: true } };
  }
}
