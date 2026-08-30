import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { notFound } from '../../common/api-error';
import { availableByProduct, stockBand } from '../../common/available-stock';
import { channelFor, priceOn, type PriceChannel } from './portal-pricing';

/**
 * What a shop can see of the catalogue.
 *
 * Everything a customer is shown is assembled here, already resolved: the
 * price on their channel and the stock as a band. Nothing downstream chooses
 * between two prices and nothing downstream is handed a quantity it could
 * accidentally render.
 */

export interface CatalogueItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: { id: string; name: string } | null;
  price: string | null;
  currency: 'EGP';
  channel: PriceChannel;
  stock: 'IN_STOCK' | 'LOW' | 'OUT';
  image: string | null;
}

@Injectable()
export class PortalCatalogueService {
  constructor(private prisma: PrismaService) {}

  /** The viewer's shop, or null for an anonymous reader. */
  private async viewerOf(customerId?: string) {
    if (!customerId) return null;
    return this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, type: true, verificationStatus: true, displayName: true },
    });
  }

  async list(
    params: { search?: string; categoryId?: string; page?: number; limit?: number },
    customerId?: string,
  ) {
    const limit = Math.min(params.limit ?? 24, 60);
    const page = Math.max(params.page ?? 1, 1);
    const customer = await this.viewerOf(customerId);
    const channel = channelFor({ customer });

    const where: Prisma.ProductWhereInput = {
      status: 'ACTIVE',
      ...(params.categoryId ? { categoryId: params.categoryId } : {}),
      ...(params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { sku: { contains: params.search, mode: 'insensitive' } },
              { barcode: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, products] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: { select: { id: true, name: true } },
          prices: { select: { channel: true, amount: true, effectiveTo: true } },
          fileAssets: {
            where: { variant: 'CARD' },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { objectKey: true },
          },
        },
      }),
    ]);

    // One aggregate for the page rather than one per card.
    const stock = await availableByProduct(
      this.prisma,
      products.map((p) => p.id),
    );

    const items: CatalogueItem[] = products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      price: priceOn(p.prices, channel)?.toFixed(2) ?? null,
      currency: 'EGP',
      channel,
      stock: stockBand(stock.get(p.id) ?? new Prisma.Decimal(0)),
      image: p.fileAssets[0] ? imageUrl(p.fileAssets[0].objectKey) : null,
    }));

    return {
      data: {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        // Echoed so the storefront can say "trade prices" without deciding for
        // itself which tier it is looking at.
        channel,
        viewer: customer ? { verified: customer.verificationStatus === 'VERIFIED' } : null,
      },
    };
  }

  async bySku(sku: string, customerId?: string) {
    const customer = await this.viewerOf(customerId);
    const channel = channelFor({ customer });

    const product = await this.prisma.product.findUnique({
      where: { sku },
      include: {
        category: { select: { id: true, name: true } },
        prices: { select: { channel: true, amount: true, effectiveTo: true } },
        compatibilities: { include: { motorcycleModel: true } },
        fileAssets: {
          where: { variant: { in: ['CARD', 'THUMB'] } },
          orderBy: { createdAt: 'asc' },
          select: { objectKey: true, variant: true },
        },
      },
    });

    // An inactive product is not found rather than forbidden. A shop has no
    // business learning that a SKU exists but has been withdrawn.
    if (!product || product.status !== 'ACTIVE') throw notFound('product');

    const stock = await availableByProduct(this.prisma, [product.id]);

    return {
      data: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        price: priceOn(product.prices, channel)?.toFixed(2) ?? null,
        currency: 'EGP',
        channel,
        stock: stockBand(stock.get(product.id) ?? new Prisma.Decimal(0)),
        fitsModels: product.compatibilities.map(
          (c) => `${c.motorcycleModel.make} ${c.motorcycleModel.model}`.trim(),
        ),
        images: product.fileAssets
          .filter((a) => a.variant === 'CARD')
          .map((a) => imageUrl(a.objectKey)),
      },
    };
  }

  async categories() {
    const rows = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true },
    });
    return { data: rows };
  }
}

/**
 * Where the storefront fetches an image from.
 *
 * A path rather than a full URL: the storefront and the API are behind the same
 * proxy, and baking a host in here would mean the value stored in a response
 * depended on which environment produced it.
 */
function imageUrl(objectKey: string): string {
  return `/api/v1/portal/images/${objectKey}`;
}
