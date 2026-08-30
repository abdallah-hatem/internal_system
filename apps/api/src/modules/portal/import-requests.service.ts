import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { badRequest, conflict, notFound } from '../../common/api-error';

/**
 * "Bring me this — here is a photo of it."
 *
 * The other half of the storefront, and the half that only makes sense for an
 * importer. A shop wants a part that is not stocked; they describe it, say what
 * it fits, and photograph the one they are holding. The owner answers.
 *
 * Unlike an order request this holds nothing and promises nothing, so an
 * unverified shop may send one. That is deliberate: it is how a shop that has
 * just signed up starts a conversation, and refusing it would leave a new
 * account with nothing to do but wait.
 *
 * The photographs are the point. A part number is often wrong or absent and a
 * picture of the thing in someone's hand is what actually identifies it, which
 * is why `ProductRequest.assetId` — one image, no relation behind it — was
 * replaced with a real foreign key that allows several.
 */

/** Enough for the part, the box, and the number stamped on it. */
export const MAX_PHOTOS = 6;

@Injectable()
export class ImportRequestsService {
  constructor(
    private prisma: PrismaService,
    private files: FilesService,
  ) {}

  async create(
    customerId: string,
    data: {
      productName: string;
      compatibilityText?: string;
      quantity?: number;
      supplierUrl?: string;
      notes?: string;
    },
  ) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw notFound('customer');

    const request = await this.prisma.productRequest.create({
      data: {
        customerId,
        productName: data.productName.trim(),
        compatibilityText: data.compatibilityText?.trim(),
        quantity: data.quantity,
        supplierUrl: data.supplierUrl?.trim(),
        notes: data.notes?.trim(),
      },
    });

    return { data: this.present(await this.load(request.id, customerId)) };
  }

  /**
   * Attach a photograph.
   *
   * Separate from creating the request rather than one multipart call: a shop
   * on a workshop connection uploading three photos should not lose the text
   * they typed because the second one timed out. The request exists first, and
   * each photo is its own attempt.
   */
  async addPhoto(customerId: string, id: string, file: Buffer, uploadedBy: string) {
    const request = await this.load(id, customerId);

    if (request.status !== 'PENDING' && request.status !== 'SOURCING') {
      throw conflict(
        'REQUEST_ALREADY_DECIDED',
        'This request has already been answered, so it cannot be changed.',
      );
    }

    const existing = await this.prisma.fileAsset.count({
      where: { productRequestId: id, variant: 'ORIGINAL' },
    });
    if (existing >= MAX_PHOTOS) {
      throw badRequest('TOO_MANY_PHOTOS', `A request can carry at most ${MAX_PHOTOS} photos.`, {
        max: MAX_PHOTOS,
      });
    }

    await this.files.upload({ productRequestId: id }, file, uploadedBy);
    return { data: this.present(await this.load(id, customerId)) };
  }

  async listForShop(customerId: string) {
    const rows = await this.prisma.productRequest.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        photos: { where: { variant: 'CARD' }, select: { id: true, objectKey: true } },
        product: { select: { id: true, sku: true, name: true } },
      },
    });
    return { data: rows.map((r) => this.present(r)) };
  }

  async detailForShop(customerId: string, id: string) {
    return { data: this.present(await this.load(id, customerId)) };
  }

  /**
   * The bytes of one photo on one request, for the shop that owns it.
   *
   * The request is loaded scoped to the customer first, so an asset id from
   * somebody else's request cannot be fetched by pairing it with a request id
   * of your own — the photo has to belong to the request, and the request has
   * to belong to you.
   */
  async photo(customerId: string, id: string, assetId: string) {
    await this.load(id, customerId);

    const asset = await this.prisma.fileAsset.findFirst({
      where: { id: assetId, productRequestId: id },
      select: { objectKey: true },
    });
    if (!asset) throw notFound('file');

    return this.files.serveFile(asset.objectKey);
  }

  /** Withdraw one, while it is still unanswered. */
  async cancel(customerId: string, id: string) {
    const request = await this.load(id, customerId);
    if (request.status !== 'PENDING') {
      throw conflict(
        'REQUEST_ALREADY_DECIDED',
        'This request has already been answered, so it cannot be withdrawn.',
      );
    }

    await this.prisma.productRequest.update({
      where: { id },
      data: { status: 'DECLINED', decisionNote: 'Withdrawn by the shop.', decidedAt: new Date() },
    });

    return { data: this.present(await this.load(id, customerId)) };
  }

  /**
   * One request, scoped to its owner in the query itself.
   *
   * `customerId` is part of the lookup rather than checked after it. A find
   * followed by an `if` is the shape that gets forgotten.
   */
  private async load(id: string, customerId: string) {
    const row = await this.prisma.productRequest.findFirst({
      where: { id, customerId },
      include: {
        photos: { where: { variant: 'CARD' }, select: { id: true, objectKey: true } },
        product: { select: { id: true, sku: true, name: true } },
      },
    });
    if (!row) throw notFound('productRequest');
    return row;
  }

  private present(r: any) {
    return {
      id: r.id,
      productName: r.productName,
      compatibilityText: r.compatibilityText,
      quantity: r.quantity?.toString() ?? null,
      supplierUrl: r.supplierUrl,
      notes: r.notes,
      status: r.status,
      decisionNote: r.decisionNote,
      // Served through the portal's own route, not `/files/download`.
      //
      // That one is an internal-surface route, so a shop's token is refused by
      // the surface guard and a shop could not see its own photograph — the
      // fence working exactly as intended and my URL being wrong. This route
      // resolves the asset through the request, so the ownership check is the
      // same one that already found the request.
      photos: r.photos.map((p: any) => ({
        id: p.id,
        url: `/api/v1/portal/imports/${r.id}/photos/${p.id}`,
      })),
      // Set when the owner turns the request into something we now stock, so
      // the shop can go straight from "you asked for this" to buying it.
      product: r.product,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
    };
  }
}
