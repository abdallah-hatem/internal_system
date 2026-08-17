import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
export declare class UsersService {
    private prisma;
    constructor(prisma: PrismaService);
    findAll(pagination: PaginationDto & {
        role?: string;
        status?: string;
    }): Promise<{
        data: {
            partner: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                version: number;
                displayName: string;
                active: boolean;
                userId: string;
            } | null;
            id: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
            status: import(".prisma/client").$Enums.UserStatus;
            lastLoginAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        }[];
        meta: {
            nextCursor: string | null;
            limit: number;
        };
    }>;
    findById(id: string): Promise<{
        data: {
            partner: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                version: number;
                displayName: string;
                active: boolean;
                userId: string;
            } | null;
            id: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
            status: import(".prisma/client").$Enums.UserStatus;
            lastLoginAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        };
    }>;
    create(data: {
        email: string;
        password: string;
        role: string;
        displayName?: string;
    }): Promise<{
        data: {
            partner: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                version: number;
                displayName: string;
                active: boolean;
                userId: string;
            } | null;
            id: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
            status: import(".prisma/client").$Enums.UserStatus;
            lastLoginAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        };
    }>;
    update(id: string, data: {
        email?: string;
        role?: string;
        status?: string;
        displayName?: string;
    }): Promise<{
        data: {
            partner: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                version: number;
                displayName: string;
                active: boolean;
                userId: string;
            } | null;
            id: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
            status: import(".prisma/client").$Enums.UserStatus;
            lastLoginAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        };
    }>;
    deactivate(id: string): Promise<{
        data: {
            partner: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                version: number;
                displayName: string;
                active: boolean;
                userId: string;
            } | null;
            id: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
            status: import(".prisma/client").$Enums.UserStatus;
            lastLoginAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            version: number;
        };
    }>;
}
