import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(
    pagination: PaginationDto & {
      type?: string;
      search?: string;
    },
  ) {
    const { cursor, limit: rawLimit = 20, type, search } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { displayName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.customer.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { saleOrders: true, payments: true },
        },
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
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        saleOrders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { items: true },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return { data: customer };
  }

  async create(
    data: {
      type: 'B2B' | 'B2C';
      displayName: string;
      phone?: string;
      email?: string;
    },
    actorId: string,
  ) {
    const customer = await this.prisma.customer.create({
      data: {
        type: data.type,
        displayName: data.displayName,
        phone: data.phone,
        email: data.email,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Customer',
      entityId: customer.id,
      afterJson: customer,
    });

    return { data: customer };
  }

  async update(
    id: string,
    data: {
      type?: 'B2B' | 'B2C';
      displayName?: string;
      phone?: string;
      email?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Customer not found');

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        type: data.type,
        displayName: data.displayName,
        phone: data.phone,
        email: data.email,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Customer',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }
}
