import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { FilesService } from './files.service';
import { MAX_UPLOAD_BYTES } from './image-pipeline';
import { badRequest } from '../../common/api-error';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { wildcardPath } from '../../common/wildcard-path';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { type Viewer } from '../../common/investor-scope';

@ApiTags('Files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private filesService: FilesService) {}

  /**
   * Add a picture to a product.
   *
   * Internal — this is the office adding photographs to the catalogue. The
   * limit is enforced by multer, before the bytes are in memory: checking the
   * length afterwards means having already read whatever was sent.
   */
  // Core partners, who are the ones that may change a product (rule 12):
  // before R1 any signed-in account could add or delete catalogue photos.
  @Post('products/:productId')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('CORE_PARTNER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add a photo to a product' })
  uploadProductImage(
    @Param('productId') productId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { id: string },
  ) {
    if (!file) throw badRequest('FILE_REQUIRED', 'No file was sent.');
    return this.filesService.upload({ productId }, file.buffer, user.id);
  }

  @Get('products/:productId')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'The photos on a product' })
  listProductImages(@Param('productId') productId: string) {
    return this.filesService.listFor({ productId });
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Remove an image and the sizes derived from it' })
  remove(@Param('id') id: string) {
    return this.filesService.remove(id);
  }

  /**
   * Serve the bytes.
   *
   * Still behind a login: this route reaches every image including the photos
   * on customers' requests. The catalogue's own images are served by the portal
   * controller, which is public and restricted to product images. A temporary
   * investor gets product photos only — a customer's request is not theirs to
   * see (R1).
   */
  @Get('download/*objectKey')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Download a file' })
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: Viewer,
  ) {
    // Not `@Param('objectKey')`: Express 5 gives Nest an array of segments and
    // the parameter arrives comma-joined, so every key with a slash in it —
    // which is all of them — missed. See `wildcardPath`.
    const { buffer, mimeType } = await this.filesService.serveFile(
      wildcardPath(req, '/files/download/'),
      user,
    );
    res.set({ 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=3600' });
    res.send(buffer);
  }
}
