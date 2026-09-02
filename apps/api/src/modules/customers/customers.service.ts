import {
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

import { notFound } from '../../common/api-error';
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
      verification?: string;
    },
  ) {
    const { cursor, limit: rawLimit = 20, type, search, verification } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (type) where.type = type;

    // Unverified shops are hidden unless asked for.
    //
    // Anyone can create one by filling in the storefront's signup form — the
    // owner's decision of 2026-08-30, taken knowing it puts strangers in the
    // table that orders and balances hang off. They are kept out of the list by
    // default so a morning's spam does not bury the real customers, and shown
    // deliberately through `verification=UNVERIFIED` when someone sits down to
    // work through them.
    //
    // `verification=ALL` is the escape hatch for a search that should find
    // everything, so a name typed into the box does not silently miss an
    // account that exists.
    if (verification === 'UNVERIFIED' || verification === 'VERIFIED') {
      where.verificationStatus = verification;
    } else if (verification !== 'ALL') {
      where.verificationStatus = { not: 'UNVERIFIED' };
    }
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
    if (!customer) throw notFound('customer');
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
        // Verified, because a person in the office just created it.
        //
        // The column defaults to UNVERIFIED, which is the right default for a
        // row that arrives without anyone saying where it came from — and the
        // storefront's self-signup relies on it. But verification means "a
        // person has vetted this account", and that is exactly what happened
        // here. Taking the default made every customer the office added
        // unsellable-to, which forty-four tests said in one run.
        verificationStatus: 'VERIFIED',
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

  /**
   * Vet a shop that signed itself up.
   *
   * Self-signup writes an UNVERIFIED customer, and every service that moves
   * money refuses one — so without this the account can browse, can ask for an
   * import, and can never become a customer. `update` deliberately does not
   * accept `verificationStatus`: lifting it is a decision a person makes about
   * an account, not a field edited in passing on a form.
   *
   * Idempotent. Verifying twice is a double-click, not an error, and it should
   * not put a second row in the audit log saying nothing changed.
   */
  async verify(id: string, actorId: string) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw notFound('customer');

    if (existing.verificationStatus === 'VERIFIED') return { data: existing };

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { verificationStatus: 'VERIFIED' },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'VERIFY',
      entityType: 'Customer',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
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
    if (!existing) throw notFound('customer');

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
