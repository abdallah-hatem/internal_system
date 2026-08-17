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
exports.FilesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
let FilesService = class FilesService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getSignedUploadUrl(data) {
        const id = crypto.randomUUID();
        const ext = path.extname(data.fileName);
        const objectKey = `${data.ownerType}/${data.ownerId}/${id}${ext}`;
        const fileAsset = await this.prisma.fileAsset.create({
            data: {
                ownerType: data.ownerType,
                ownerId: data.ownerId,
                objectKey,
                mimeType: data.mimeType,
                sizeBytes: data.sizeBytes,
            },
        });
        const uploadUrl = `/api/v1/files/upload/${fileAsset.id}`;
        return {
            data: {
                fileAssetId: fileAsset.id,
                uploadUrl,
                objectKey,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
        };
    }
    async uploadFile(fileAssetId, file, originalName) {
        const fileAsset = await this.prisma.fileAsset.findUnique({ where: { id: fileAssetId } });
        if (!fileAsset)
            throw new common_1.NotFoundException('File asset not found');
        const dir = path.dirname(path.join(UPLOAD_DIR, fileAsset.objectKey));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(UPLOAD_DIR, fileAsset.objectKey), file);
        return { data: { id: fileAsset.id, objectKey: fileAsset.objectKey, status: 'uploaded' } };
    }
    async getSignedDownloadUrl(objectKey) {
        return {
            data: {
                url: `/api/v1/files/download/${encodeURIComponent(objectKey)}`,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
        };
    }
    async serveFile(objectKey) {
        const filePath = path.join(UPLOAD_DIR, objectKey);
        try {
            const buffer = await fs.readFile(filePath);
            const fileAsset = await this.prisma.fileAsset.findFirst({ where: { objectKey } });
            return { buffer, mimeType: fileAsset?.mimeType || 'application/octet-stream' };
        }
        catch {
            throw new common_1.NotFoundException('File not found');
        }
    }
    async getFilesByOwner(ownerType, ownerId) {
        const files = await this.prisma.fileAsset.findMany({
            where: { ownerType, ownerId },
            orderBy: { createdAt: 'desc' },
        });
        return { data: files };
    }
};
exports.FilesService = FilesService;
exports.FilesService = FilesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FilesService);
//# sourceMappingURL=files.service.js.map