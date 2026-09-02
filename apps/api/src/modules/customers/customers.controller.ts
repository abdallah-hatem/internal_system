import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('customers')
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'List customers with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      type?: string;
      search?: string;
      /** VERIFIED | UNVERIFIED | ALL. Omitted hides unverified signups. */
      verification?: string;
    },
  ) {
    return this.customersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer details with orders and payments' })
  findById(@Param('id') id: string) {
    return this.customersService.findById(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a new customer (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.customersService.create(body, user.id);
  }

  @Post(':id/verify')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Vet a self-signed-up shop (CORE_PARTNER only). Until this runs, every ' +
      'service that moves money refuses the account.',
  })
  verify(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customersService.verify(id, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a customer (CORE_PARTNER only)' })
  update(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.customersService.update(id, body, user.id);
  }
}
