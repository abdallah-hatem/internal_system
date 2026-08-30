import { PrismaService } from '../../prisma/prisma.service';
import { badRequest, notFound } from '../../common/api-error';

/**
 * Who may be put on a cycle, and as what.
 *
 * Nothing checked this. `cycleParticipant.create` took any UUID that satisfied
 * the foreign key, so a `SHOP_OWNER_PORTAL` account — a customer's storefront
 * login — could be made a CORE_PARTNER on a cycle. One had been: a shop owner
 * sitting on a cycle with a 5,000 contribution, which means a share of the
 * partners' profit at settlement and cycle notifications carrying everyone's
 * contribution figures.
 *
 * `RolesGuard` is about who may CALL the endpoint. This is about who the call
 * may name, which is a different question and was not being asked at all —
 * `CLAUDE.md` rule 12 with the subject and the caller the wrong way round.
 *
 * DECIDED 2026-08-30, and written into docs/business-rules.md: a core partner
 * may also come in as a temporary investor on a cycle, because putting extra
 * money in beside your own share is a real thing an owner does. A shop owner
 * can be neither.
 */
export async function assertCanParticipate(
  prisma: PrismaService,
  userId: string,
  participantType: 'CORE_PARTNER' | 'TEMP_INVESTOR',
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });

  // Without this the foreign key fails deep in Prisma and surfaces as "an
  // unexpected error occurred", which tells whoever typed the id nothing.
  if (!user) throw notFound('user');

  if (user.role === 'SHOP_OWNER_PORTAL') {
    throw badRequest(
      'SHOP_CANNOT_PARTICIPATE',
      'A shop account cannot be a partner or an investor on a cycle.',
    );
  }

  if (user.role === 'ADMIN_SUPPORT') {
    throw badRequest(
      'ROLE_CANNOT_PARTICIPATE',
      'An office account with no stake cannot be a participant on a cycle.',
    );
  }

  if (participantType === 'CORE_PARTNER' && user.role !== 'CORE_PARTNER') {
    throw badRequest(
      'NOT_A_CORE_PARTNER',
      'Only a core partner can be added as one. Add them as a temporary investor instead.',
    );
  }

  if (user.status !== 'ACTIVE') {
    throw badRequest(
      'PARTICIPANT_NOT_ACTIVE',
      'That account is not active, so it cannot take a share of a cycle.',
    );
  }
}
