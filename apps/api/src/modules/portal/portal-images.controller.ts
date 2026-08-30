import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { notFound } from '../../common/api-error';
import { Surface } from '../../common/surface';
import { wildcardPath } from '../../common/wildcard-path';

/**
 * Catalogue images, and only catalogue images.
 *
 * The `files` module serves every asset behind a login, which is right: it
 * reaches the photographs customers attach to their own import requests, and
 * those are not public. The shop window needs the opposite — an anonymous
 * visitor must see a product photo before they have an account — so it gets its
 * own route rather than a hole punched in that one.
 *
 * The narrowing is the point. This looks the key up and refuses anything whose
 * asset is not attached to a product, so a request photo cannot be fetched by
 * guessing its key, and neither can a file the database has never heard of.
 */
@ApiTags('Portal')
@Surface('public')
@Controller('portal/images')
export class PortalImagesController {
  constructor(
    private prisma: PrismaService,
    private files: FilesService,
  ) {}

  @Get('*objectKey')
  @ApiOperation({ summary: 'A product photo, public' })
  async serve(@Req() req: Request, @Res() res: Response) {
    const key = wildcardPath(req, '/portal/images/');

    const asset = await this.prisma.fileAsset.findFirst({
      where: { objectKey: key, productId: { not: null } },
      select: { objectKey: true, mimeType: true },
    });
    // Not found rather than forbidden, deliberately: telling an anonymous
    // caller that a key exists but belongs to a customer's request is telling
    // them something about a customer.
    if (!asset) throw notFound('file');

    const { buffer, mimeType } = await this.files.serveFile(asset.objectKey);
    res.set({
      'Content-Type': mimeType,
      // Long, and safe to be long: the key contains a uuid, so a replaced
      // photo is a different key rather than the same one with new bytes.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.send(buffer);
  }
}
