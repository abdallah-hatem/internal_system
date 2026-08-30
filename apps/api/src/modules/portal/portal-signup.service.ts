import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { conflict } from '../../common/api-error';
import { PortalNotifier } from '../notifications/portal-notifier.service';

/**
 * A shop signing itself up.
 *
 * Decision of 2026-08-30: a signup becomes a `Customer` with
 * `verificationStatus = UNVERIFIED`, plus the portal login attached to it. The
 * owner was told this lets a stranger create a row in the table that orders,
 * payments and balances hang off, and chose it anyway for reusing a column the
 * schema already has.
 *
 * So it is contained rather than argued. The containment is not here — it is in
 * the services that move money, each of which refuses an unverified customer,
 * and in the Customers list, which filters them out by default. What is here is
 * the narrow part: this creates an account that can browse and can ask for
 * something imported, and can do nothing else until a person looks at it.
 */
@Injectable()
export class PortalSignupService {
  constructor(
    private prisma: PrismaService,
    private notifier: PortalNotifier,
  ) {}

  async signUp(data: { email: string; password: string; shopName: string; phone?: string }) {
    const email = data.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Said plainly. Hiding it behind a generic message to avoid confirming
      // the address exists would mean a shop that already signed up last month
      // has no way to work out why it cannot sign up again — and the address is
      // already discoverable through the login form either way.
      throw conflict('EMAIL_TAKEN', 'That email already has an account.');
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    // One transaction. A user with no customer cannot sign in — `portalLogin`
    // refuses it with PORTAL_ACCOUNT_INCOMPLETE — so half of this is worse than
    // none of it.
    const customer = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, passwordHash, role: 'SHOP_OWNER_PORTAL', status: 'ACTIVE' },
      });

      return tx.customer.create({
        data: {
          displayName: data.shopName.trim(),
          // B2B is the shape of every shop that signs up here; it decides
          // nothing about pricing while they are unverified, because an
          // unverified account is quoted retail regardless.
          type: 'B2B',
          phone: data.phone?.trim(),
          shopOwnerUserId: user.id,
          verificationStatus: 'UNVERIFIED',
        },
      });
    });

    // Somebody has to know this is waiting, or an unverified account sits in a
    // tab nobody has a reason to open.
    await this.notifier.shopSignedUp({
      customerId: customer.id,
      shopName: customer.displayName,
    });

    // No token. Signing in is a separate act, and it is the login that decides
    // what this account can see — one place, not two.
    return {
      data: {
        customerId: customer.id,
        displayName: customer.displayName,
        verified: false,
      },
    };
  }
}
