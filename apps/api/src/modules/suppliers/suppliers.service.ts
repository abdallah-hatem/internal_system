import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

import { badRequest, notFound } from '../../common/api-error';
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
      // The list is what the suppliers page renders, and it needs to know what
      // points at each row: how many orders were bought from it, and whether
      // deleting it is even possible.
      include: {
        products: true,
        _count: { select: { purchaseOrders: true, products: true } },
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
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { include: { product: true } },
        purchaseOrders: true,
      },
    });
    if (!supplier) throw notFound('supplier');
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
    if (!existing) throw notFound('supplier');

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

  /**
   * Delete a supplier that nothing points at.
   *
   * A supplier with purchase orders is part of the cycle's cost history — the
   * landed cost of stock still on the shelf traces back through it — so it is
   * kept and the delete refused. This exists for the one created by mistake.
   */
  async remove(id: string, actorId: string) {
    const existing = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        _count: { select: { purchaseOrders: true, products: true } },
      },
    });
    if (!existing) throw notFound('supplier');

    if (existing._count.purchaseOrders > 0) {
      throw badRequest(
        'SUPPLIER_HAS_ORDERS',
        `Cannot delete supplier: ${existing._count.purchaseOrders} purchase order(s) were bought from it`,
        { count: existing._count.purchaseOrders },
      );
    }
    if (existing._count.products > 0) {
      throw badRequest(
        'SUPPLIER_HAS_PRODUCTS',
        `Cannot delete supplier: ${existing._count.products} product(s) are linked to it`,
        { count: existing._count.products },
      );
    }

    await this.prisma.supplier.delete({ where: { id } });

    await this.audit.log({
      actorUserId: actorId,
      action: 'DELETE',
      entityType: 'Supplier',
      entityId: id,
      beforeJson: existing,
    });

    return { data: { deleted: true } };
  }
}
