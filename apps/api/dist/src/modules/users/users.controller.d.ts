import { UsersService } from './users.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
export declare class UsersController {
    private usersService;
    constructor(usersService: UsersService);
    findAll(query: PaginationDto & {
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
    findOne(id: string): Promise<{
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
    create(body: {
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
    update(id: string, body: any): Promise<{
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
