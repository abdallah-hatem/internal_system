import { Controller, Post, Get, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /**
   * Create a user. Not self-service.
   *
   * This was public and the caller chose their own role, so anyone who could
   * reach the API could mint themselves a CORE_PARTNER and from there approve
   * settlements, reverse ledger entries and cancel orders. Nothing in the app
   * ever called it — the frontend has a helper for it that no screen uses — so
   * it was an open door onto the whole system for no benefit.
   *
   * The first partners come from the seed, so requiring one to exist here
   * cannot lock anybody out.
   */
  @Post('register')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a user (CORE_PARTNER only)' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: any) {
    return this.authService.getProfile(user.id);
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change current user password' })
  async changePassword(
    @CurrentUser() user: any,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(user.id, body.oldPassword, body.newPassword);
  }
}
