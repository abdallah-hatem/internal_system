import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: PaginationDto & { search?: string }) {
    const { cursor, limit: rawLimit = 20, search } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.supplier.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { name: 'asc' },
      include: { products: true },
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
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { include: { product: true } },
        purchaseOrders: true,
      },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return { data: supplier };
  }

  async create(
    data: {
      name: string;
      country: string;
      contactJson?: any;
      notes?: string;
    },
    actorId: string,
  ) {
    const supplier = await this.prisma.supplier.create({
      data: {
        name: data.name,
        country: data.country,
        contactJson: data.contactJson,
        notes: data.notes,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Supplier',
      entityId: supplier.id,
      afterJson: supplier,
    });

    return { data: supplier };
  }

  async update(
    id: string,
    data: {
      name?: string;
      country?: string;
      contactJson?: any;
      notes?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.supplier.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Supplier not found');

    const updated = await this.prisma.supplier.update({
      where: { id },
      data: {
        name: data.name,
        country: data.country,
        contactJson: data.contactJson,
        notes: data.notes,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Supplier',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }
}
