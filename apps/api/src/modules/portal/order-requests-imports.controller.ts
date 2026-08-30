import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { ImportRequestsService } from './import-requests.service';
import { AnswerImportRequestDto } from './dto/import-request.dto';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * The office answering what shops asked us to import.
 *
 * Internal by default — no `@Surface`, which is the point of that default.
 * Unlike approving an order request this moves no stock and no money, so the
 * roles are wider: whoever does the sourcing can reply without needing to be a
 * partner.
 */
@ApiTags('Import requests')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('import-requests')
export class ImportRequestsAdminController {
  constructor(private imports: ImportRequestsService) {}

  @Get()
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'What shops have asked us to bring in' })
  list(@Query('status') status?: string) {
    return this.imports.listForOffice(status);
  }

  @Post(':id/answer')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Reply to a shop about a part they asked for' })
  answer(
    @Param('id') id: string,
    @Body() dto: AnswerImportRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.imports.answer(id, user.id, dto);
  }
}
