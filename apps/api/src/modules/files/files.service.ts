import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { notFound } from '../../common/api-error';
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

@Injectable()
export class FilesService {
  constructor(private prisma: PrismaService) {}

  async getSignedUploadUrl(data: {
    ownerType: string;
    ownerId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }) {
    const id = crypto.randomUUID();
    const ext = path.extname(data.fileName);
    const objectKey = `${data.ownerType}/${data.ownerId}/${id}${ext}`;

    // Create the file asset record
    const fileAsset = await this.prisma.fileAsset.create({
      data: {
        ownerType: data.ownerType,
        ownerId: data.ownerId,
        objectKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
      },
    });

    // For local storage, return a direct upload URL
    const uploadUrl = `/api/v1/files/upload/${fileAsset.id}`;

    return {
      data: {
        fileAssetId: fileAsset.id,
        uploadUrl,
        objectKey,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  async uploadFile(fileAssetId: string, file: Buffer, originalName: string) {
    const fileAsset = await this.prisma.fileAsset.findUnique({ where: { id: fileAssetId } });
    if (!fileAsset) throw notFound('fileAsset');

    // Ensure upload directory exists
    const dir = path.dirname(path.join(UPLOAD_DIR, fileAsset.objectKey));
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(path.join(UPLOAD_DIR, fileAsset.objectKey), file);

    return { data: { id: fileAsset.id, objectKey: fileAsset.objectKey, status: 'uploaded' } };
  }

  async getSignedDownloadUrl(objectKey: string) {
    // For local storage, return direct path
    return {
      data: {
        url: `/api/v1/files/download/${encodeURIComponent(objectKey)}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  async serveFile(objectKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const filePath = path.join(UPLOAD_DIR, objectKey);
    try {
      const buffer = await fs.readFile(filePath);
      const fileAsset = await this.prisma.fileAsset.findFirst({ where: { objectKey } });
      return { buffer, mimeType: fileAsset?.mimeType || 'application/octet-stream' };
    } catch {
      throw notFound('file');
    }
  }

  async getFilesByOwner(ownerType: string, ownerId: string) {
    const files = await this.prisma.fileAsset.findMany({
      where: { ownerType, ownerId },
      orderBy: { createdAt: 'desc' },
    });
    return { data: files };
  }
}
