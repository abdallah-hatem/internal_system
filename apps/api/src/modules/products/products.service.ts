import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(
    pagination: PaginationDto & {
      categoryId?: string;
      status?: string;
      search?: string;
    },
  ) {
    const { cursor, limit = 20, categoryId, status, search } = pagination;
    const where: any = {};
    if (categoryId) where.categoryId = categoryId;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.product.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        category: true,
        suppliers: { include: { supplier: true } },
        prices: true,
      },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        suppliers: { include: { supplier: true } },
        prices: true,
        compatibilities: { include: { motorcycleModel: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return { data: product };
  }

  async create(
    data: {
      name: string;
      categoryId?: string;
      description?: string;
      barcode?: string;
      status?: string;
      minStock?: number;
    },
    actorId: string,
  ) {
    // Generate SKU: PRD-XXXXXX
    const count = await this.prisma.product.count();
    const sku = `PRD-${String(count + 1).padStart(6, '0')}`;

    const product = await this.prisma.product.create({
      data: {
        sku,
        name: data.name,
        categoryId: data.categoryId,
        description: data.description,
        barcode: data.barcode,
        status: (data.status as any) || 'ACTIVE',
        minStock: data.minStock,
      },
      include: { category: true },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Product',
      entityId: product.id,
      afterJson: product,
    });

    return { data: product };
  }

  async update(
    id: string,
    data: {
      name?: string;
      categoryId?: string;
      description?: string;
      barcode?: string;
      status?: string;
      minStock?: number;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        categoryId: data.categoryId,
        description: data.description,
        barcode: data.barcode,
        status: data.status as any,
        minStock: data.minStock,
      },
      include: { category: true },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Product',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  // ─── Category CRUD ────────────────────────────────────────────

  async findCategories() {
    const categories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { children: true },
    });
    return { data: categories };
  }

  async createCategory(
    data: { name: string; parentId?: string },
    actorId: string,
  ) {
    // Check uniqueness
    const existing = await this.prisma.category.findUnique({
      where: { name: data.name },
    });
    if (existing) {
      throw new ConflictException('Category with this name already exists');
    }

    const category = await this.prisma.category.create({ data });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Category',
      entityId: category.id,
      afterJson: category,
    });

    return { data: category };
  }

  // ─── Price Management (append-only history) ────────────────────

  async setPrice(
    productId: string,
    data: { channel: string; currency: string; amount: number },
    actorId: string,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    // Close previous price for this product+channel
    await this.prisma.productPrice.updateMany({
      where: { productId, channel: data.channel, effectiveTo: null },
      data: { effectiveTo: new Date() },
    });

    const price = await this.prisma.productPrice.create({
      data: {
        productId,
        channel: data.channel,
        currency: data.currency,
        amount: data.amount,
        effectiveFrom: new Date(),
        createdBy: actorId,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'PRICE_CHANGE',
      entityType: 'Product',
      entityId: productId,
      afterJson: price,
    });

    return { data: price };
  }

  async getPriceHistory(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    const prices = await this.prisma.productPrice.findMany({
      where: { productId },
      orderBy: { effectiveFrom: 'desc' },
    });

    return { data: prices };
  }
}
