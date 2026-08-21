import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReturnsService } from './returns.service';
import { CreateReturnDto } from './dto/return.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Returns')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('returns')
export class ReturnsController {
  constructor(private returnsService: ReturnsService) {}

  @Get()
  @ApiOperation({ summary: 'List returns' })
  findAll(@Query() query: PaginationDto & { saleOrderId?: string }) {
    return this.returnsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a return with its lines' })
  findOne(@Param('id') id: string) {
    return this.returnsService.findOne(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Take goods back: restock to the batch they were sold from, reverse the ' +
      'COGS, and credit or refund the customer',
  })
  create(@Body() body: CreateReturnDto, @CurrentUser() user: any) {
    return this.returnsService.create(body, user?.id);
  }
}
