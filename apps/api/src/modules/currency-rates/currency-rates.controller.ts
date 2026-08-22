import { Controller, Get, Put, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrencyRatesService } from './currency-rates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Currency Rates')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('currency-rates')
export class CurrencyRatesController {
  constructor(private service: CurrencyRatesService) {}

  @Get()
  @ApiOperation({ summary: 'List the current rates to EGP' })
  findAll() {
    return this.service.findAll();
  }

  @Get('map')
  @ApiOperation({ summary: 'The rates as a code→rate map, for prefilling forms' })
  asMap() {
    return this.service.asMap();
  }

  @Get(':code')
  @ApiOperation({ summary: 'Get one currency rate' })
  findOne(@Param('code') code: string) {
    return this.service.findOne(code);
  }

  @Put(':code')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Set a currency rate (CORE_PARTNER only)' })
  upsert(
    @Param('code') code: string,
    @Body() body: { rateToEgp: number | null; source?: string },
    @CurrentUser() user: any,
  ) {
    return this.service.upsert(code, body.rateToEgp, user?.id, body.source);
  }
}
