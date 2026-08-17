import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
export declare class AuthService {
    private prisma;
    private jwtService;
    constructor(prisma: PrismaService, jwtService: JwtService);
    login(dto: LoginDto): Promise<{
        data: {
            accessToken: string;
            user: {
                id: string;
                email: string;
                role: import(".prisma/client").$Enums.UserRole;
                displayName: string | undefined;
            };
        };
    }>;
    register(dto: RegisterDto): Promise<{
        data: {
            accessToken: string;
            user: {
                id: string;
                email: string;
                role: import(".prisma/client").$Enums.UserRole;
                displayName: string | undefined;
            };
        };
    }>;
    getProfile(userId: string): Promise<{
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
    changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{
        data: {
            message: string;
        };
    }>;
}
