import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrencyRatesService } from './currency-rates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

/**
 * The exchange-rate page (BUSINESS_LOGIC §22). Everyone signed in to the
 * office reads the rates — every money form prefills from them; only a core
 * partner changes or adds one.
 *
 * Bodies are checked by the service, not a DTO, so each refusal carries its
 * own code (RATE_NOT_POSITIVE, RATE_TOO_PRECISE, CURRENCY_CODE_INVALID,
 * CURRENCY_EXISTS, BASE_CURRENCY_RATE_FIXED) rather than a generic
 * VALIDATION_FAILED.
 */
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
  @ApiOperation({
    summary: 'The rates as a code→rate map, for prefilling forms',
  })
  asMap() {
    return this.service.asMap();
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary: 'Add a currency and its rate to EGP (CORE_PARTNER only)',
  })
  create(
    @Body() body: { code?: unknown; rateToEgp?: unknown; source?: unknown },
    @CurrentUser() user: { id?: string } | undefined,
  ) {
    return this.service.create(body ?? {}, user?.id);
  }

  @Get(':code')
  @ApiOperation({ summary: 'Get one currency rate' })
  findOne(@Param('code') code: string) {
    return this.service.findOne(code);
  }

  @Put(':code')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary: "Change a currency's rate to EGP (CORE_PARTNER only)",
  })
  upsert(
    @Param('code') code: string,
    @Body() body: { rateToEgp?: unknown; source?: unknown } | undefined,
    @CurrentUser() user: { id?: string } | undefined,
  ) {
    return this.service.upsert(code, body?.rateToEgp, user?.id, body?.source);
  }
}
