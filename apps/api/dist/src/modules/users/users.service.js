"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const bcrypt = require("bcrypt");
let UsersService = class UsersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(pagination) {
        const { cursor, limit = 20, role, status } = pagination;
        const where = {};
        if (role)
            where.role = role;
        if (status)
            where.status = status;
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
    async findById(id) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            include: { partner: true },
        });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        const { passwordHash, ...result } = user;
        return { data: result };
    }
    async create(data) {
        const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
        if (existing)
            throw new common_1.ConflictException('Email already exists');
        const passwordHash = await bcrypt.hash(data.password, 12);
        const user = await this.prisma.user.create({
            data: {
                email: data.email,
                passwordHash,
                role: data.role,
                partner: data.displayName ? { create: { displayName: data.displayName } } : undefined,
            },
            include: { partner: true },
        });
        const { passwordHash: _, ...result } = user;
        return { data: result };
    }
    async update(id, data) {
        const user = await this.prisma.user.findUnique({ where: { id }, include: { partner: true } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        const updated = await this.prisma.user.update({
            where: { id },
            data: {
                email: data.email,
                role: data.role,
                status: data.status,
                partner: data.displayName ? { update: { displayName: data.displayName } } : undefined,
            },
            include: { partner: true },
        });
        const { passwordHash, ...result } = updated;
        return { data: result };
    }
    async deactivate(id) {
        return this.update(id, { status: 'INACTIVE' });
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UsersService);
//# sourceMappingURL=users.service.js.map