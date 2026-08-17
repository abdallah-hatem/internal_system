import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(pagination: PaginationDto & { role?: string; status?: string }) {
    const { cursor, limit = 20, role, status } = pagination;
    const where: any = {};
    if (role) where.role = role;
    if (status) where.status = status;

    const items = await this.prisma.user.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { partner: true },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;

    return {
      data: data.map(({ passwordHash, ...user }) => user),
      meta: { nextCursor: hasMore ? data[data.length - 1].id : null, limit },
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { partner: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash, ...result } = user;
    return { data: result };
  }

  async create(data: { email: string; password: string; role: string; displayName?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new ConflictException('Email already exists');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        role: data.role as any,
        partner: data.displayName ? { create: { displayName: data.displayName } } : undefined,
      },
      include: { partner: true },
    });
    const { passwordHash: _, ...result } = user;
    return { data: result };
  }

  async update(id: string, data: { email?: string; role?: string; status?: string; displayName?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { partner: true } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        email: data.email,
        role: data.role as any,
        status: data.status as any,
        partner: data.displayName ? { update: { displayName: data.displayName } } : undefined,
      },
      include: { partner: true },
    });
    const { passwordHash, ...result } = updated;
    return { data: result };
  }

  async deactivate(id: string) {
    return this.update(id, { status: 'INACTIVE' });
  }
}
