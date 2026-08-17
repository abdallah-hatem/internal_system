import { PrismaService } from '../../prisma/prisma.service';
export declare class FilesService {
    private prisma;
    constructor(prisma: PrismaService);
    getSignedUploadUrl(data: {
        ownerType: string;
        ownerId: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
    }): Promise<{
        data: {
            fileAssetId: string;
            uploadUrl: string;
            objectKey: string;
            expiresAt: string;
        };
    }>;
    uploadFile(fileAssetId: string, file: Buffer, originalName: string): Promise<{
        data: {
            id: string;
            objectKey: string;
            status: string;
        };
    }>;
    getSignedDownloadUrl(objectKey: string): Promise<{
        data: {
            url: string;
            expiresAt: string;
        };
    }>;
    serveFile(objectKey: string): Promise<{
        buffer: Buffer;
        mimeType: string;
    }>;
    getFilesByOwner(ownerType: string, ownerId: string): Promise<{
        data: {
            id: string;
            createdAt: Date;
            ownerType: string;
            objectKey: string;
            mimeType: string;
            sizeBytes: number;
            ownerId: string;
        }[];
    }>;
}
