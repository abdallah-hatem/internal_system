import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { PortalSignupService } from './portal-signup.service';
import { PortalSignupDto } from './dto/signup.dto';
import { Surface } from '../../common/surface';

/**
 * The only route on which someone who is nobody yet can write to the database.
 *
 * Public by necessity and narrow by design: it creates an unverified account
 * and nothing else. Everything that moves money refuses such an account, so the
 * worst a stranger can do here is add a row a person will decline.
 */
@ApiTags('Portal')
@Surface('public')
@Controller('auth/portal')
export class PortalSignupController {
  constructor(private signup: PortalSignupService) {}

  @Post('signup')
  @ApiOperation({ summary: 'Create a shop account, pending verification' })
  create(@Body() dto: PortalSignupDto) {
    return this.signup.signUp(dto);
  }
}
