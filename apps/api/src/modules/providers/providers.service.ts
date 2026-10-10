import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { cyclesVisibleTo, type ScopeViewer } from '../../common/investor-scope';
import { isUuid } from '../../common/uuid';
@Injectable()
export class ProvidersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * An investor: only the providers that carried their cycles' legs, with
   * only those legs counted (R1). Everyone else: every provider.
   */
  private async legScope(viewer: ScopeViewer) {
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    return scope === null ? undefined : { cycleId: { in: [...scope] } };
  }

  async findAll(viewer: ScopeViewer = 'internal') {
    const ours = await this.legScope(viewer);
    const items = await this.prisma.provider.findMany({
      where: ours ? { shippingLegs: { some: ours } } : undefined,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { shippingLegs: ours ? { where: ours } : true } },
      },
    });
    return { data: items };
  }

  async findById(id: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(id)) throw notFound('provider');
    const ours = await this.legScope(viewer);
    const provider = await this.prisma.provider.findFirst({
      where: ours ? { id, shippingLegs: { some: ours } } : { id },
      include: {
        _count: { select: { shippingLegs: ours ? { where: ours } : true } },
      },
    });
    if (!provider) throw notFound('provider');
    return { data: provider };
  }

  async create(
    data: {
      name: string;
      contactPerson?: string;
      phone?: string;
      email?: string;
      notes?: string;
    },
    actorId: string,
  ) {
    const provider = await this.prisma.provider.create({
      data: {
        name: data.name,
        contactPerson: data.contactPerson,
        phone: data.phone,
        email: data.email,
        notes: data.notes,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Provider',
      entityId: provider.id,
      afterJson: provider,
    });

    return { data: provider };
  }

  async update(
    id: string,
    data: {
      name?: string;
      contactPerson?: string;
      phone?: string;
      email?: string;
      notes?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.provider.findUnique({ where: { id } });
    if (!existing) throw notFound('provider');

    const updated = await this.prisma.provider.update({
      where: { id },
      data: {
        name: data.name,
        contactPerson: data.contactPerson,
        phone: data.phone,
        email: data.email,
        notes: data.notes,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Provider',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.provider.findUnique({
      where: { id },
      include: {
        _count: { select: { shippingLegs: true, lossRefunds: true } },
      },
    });
    if (!existing) throw notFound('provider');

    // A loss refund it paid points at it too (§6): once a leg is moved to
    // another company, the refund still names this one.
    if (existing._count.shippingLegs > 0 || existing._count.lossRefunds > 0) {
      throw badRequest(
        'PROVIDER_IN_USE',
        'Cannot delete provider: it is referenced by shipping legs',
      );
    }

    await this.prisma.provider.delete({ where: { id } });

    await this.audit.log({
      actorUserId: actorId,
      action: 'DELETE',
      entityType: 'Provider',
      entityId: id,
      beforeJson: existing,
    });

    return { data: { deleted: true } };
  }
}
