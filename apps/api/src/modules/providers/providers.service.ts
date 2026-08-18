import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ProvidersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll() {
    const items = await this.prisma.provider.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { shippingLegs: true } } },
    });
    return { data: items };
  }

  async findById(id: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { id },
      include: { _count: { select: { shippingLegs: true } } },
    });
    if (!provider) throw new NotFoundException('Provider not found');
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
    if (!existing) throw new NotFoundException('Provider not found');

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
      include: { _count: { select: { shippingLegs: true } } },
    });
    if (!existing) throw new NotFoundException('Provider not found');

    if (existing._count.shippingLegs > 0) {
      throw new BadRequestException(
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
