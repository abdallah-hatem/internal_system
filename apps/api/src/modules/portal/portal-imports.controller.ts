import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';

import { ImportRequestsService } from './import-requests.service';
import { CreateImportRequestDto } from './dto/import-request.dto';
import { MAX_UPLOAD_BYTES } from '../files/image-pipeline';
import { badRequest } from '../../common/api-error';
import { Surface } from '../../common/surface';
import { CurrentShop } from '../../common/decorators/current-shop.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * A shop asking for something we do not stock.
 *
 * Open to an unverified account, unlike an order request: this holds no stock
 * and promises nothing, and it is how a shop that has just signed up starts a
 * conversation rather than sitting in a queue with nothing to do.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@Surface('portal')
@UseGuards(AuthGuard('jwt'))
@Controller('portal/imports')
export class PortalImportsController {
  constructor(private imports: ImportRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Import requests this shop has made' })
  list(@CurrentShop() customerId: string) {
    return this.imports.listForShop(customerId);
  }

  @Post()
  @ApiOperation({ summary: 'Ask for something we do not stock' })
  create(@CurrentShop() customerId: string, @Body() dto: CreateImportRequestDto) {
    return this.imports.create(customerId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of this shop’s import requests' })
  detail(@CurrentShop() customerId: string, @Param('id') id: string) {
    return this.imports.detailForShop(customerId, id);
  }

  /**
   * One photo per call.
   *
   * A shop on a workshop connection uploading three photos should not lose the
   * text they typed because the second one timed out. The size cap is enforced
   * by multer, before the bytes are in memory.
   */
  @Post(':id/photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a photo of the part' })
  addPhoto(
    @CurrentShop() customerId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: { id: string },
  ) {
    if (!file) throw badRequest('FILE_REQUIRED', 'No file was sent.');
    return this.imports.addPhoto(customerId, id, file.buffer, user.id);
  }

  @Get(':id/photos/:assetId')
  @ApiOperation({ summary: 'One photo on this shop’s own request' })
  async photo(
    @CurrentShop() customerId: string,
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Res() res: Response,
  ) {
    const { buffer, mimeType } = await this.imports.photo(customerId, id, assetId);
    // Private: this is one customer's photograph and must never be held by a
    // shared cache between here and them.
    res.set({ 'Content-Type': mimeType, 'Cache-Control': 'private, max-age=3600' });
    res.send(buffer);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Withdraw a request that has not been answered' })
  cancel(@CurrentShop() customerId: string, @Param('id') id: string) {
    return this.imports.cancel(customerId, id);
  }
}
