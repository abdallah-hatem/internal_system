import { Controller, Get, Post, Param, Body, Res, UseGuards, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { Response } from 'express';
import { FilesService } from './files.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('files')
export class FilesController {
  constructor(private filesService: FilesService) {}

  @Post('signed-url')
  @ApiOperation({ summary: 'Get a signed upload URL' })
  getSignedUrl(@Body() body: { ownerType: string; ownerId: string; fileName: string; mimeType: string; sizeBytes: number }) {
    return this.filesService.getSignedUploadUrl(body);
  }

  @Post('upload/:id')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file' })
  upload(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.filesService.uploadFile(id, file.buffer, file.originalname);
  }

  @Get('download/*objectKey')
  @ApiOperation({ summary: 'Download a file' })
  async download(@Param('objectKey') objectKey: string, @Res() res: Response) {
    const { buffer, mimeType } = await this.filesService.serveFile(decodeURIComponent(objectKey));
    res.set({ 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=3600' });
    res.send(buffer);
  }

  @Get('owner/:ownerType/:ownerId')
  @ApiOperation({ summary: 'List files for an owner' })
  getFilesByOwner(@Param('ownerType') ownerType: string, @Param('ownerId') ownerId: string) {
    return this.filesService.getFilesByOwner(ownerType, ownerId);
  }
}
