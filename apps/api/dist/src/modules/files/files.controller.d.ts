import { Response } from 'express';
import { FilesService } from './files.service';
export declare class FilesController {
    private filesService;
    constructor(filesService: FilesService);
    getSignedUrl(body: {
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
    upload(id: string, file: Express.Multer.File): Promise<{
        data: {
            id: string;
            objectKey: string;
            status: string;
        };
    }>;
    download(objectKey: string, res: Response): Promise<void>;
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
