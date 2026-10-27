import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from '../../prisma/unique-violation';
import { AuditService } from '../audit/audit.service';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { isUuid } from '../../common/uuid';
import { assertNotWalkIn } from '../../common/walk-in';
import { NO_BRANCH, owedByBranch } from '../../common/customer-branches';

/** Longer than any branch name anyone types; a guard against a pasted page. */
export const BRANCH_NAME_MAX = 80;
const FIELD_MAX = 200;

export interface BranchInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  isDefault?: boolean;
}

/**
 * A customer's branches: add, rename, archive, restore, and which one is the
 * default (BUSINESS_LOGIC §7, owner 2026-10-25).
 *
 * Two rules the database also holds, so two saves at once cannot get past them:
 * a name once per customer ignoring case (`customer_branches_customer_name`),
 * and at most one default (`customer_branches_one_default`). The service checks
 * first so the usual refusal is coded; the index catches the race.
 */
@Injectable()
export class CustomerBranchesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * The customer's branches with what each owes, archived ones last. Also what
   * is owed on no branch and in total, so the page shows figures that add up
   * without summing in the browser.
   */
  async list(customerId: string) {
    await this.customer(customerId);
    const branches = await this.prisma.customerBranch.findMany({
      where: { customerId },
      orderBy: [
        { archivedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ],
      include: { _count: { select: { saleOrders: true } } },
    });
    const owed = await owedByBranch(
      this.prisma,
      customerId,
      branches.map((b) => b.id),
    );
    const total = [...owed.values()].reduce(
      (cents, v) => cents + Math.round(Number(v) * 100),
      0,
    );
    return {
      data: branches.map(({ _count, ...b }) => ({
        ...b,
        orderCount: _count.saleOrders,
        owed: owed.get(b.id) ?? '0.00',
      })),
      meta: {
        noBranchOwed: owed.get(NO_BRANCH) ?? '0.00',
        totalOwed: (total / 100).toFixed(2),
      },
    };
  }

  async create(customerId: string, input: BranchInput, actorId: string) {
    const customer = await this.customer(customerId);
    assertNotWalkIn(customer);
    const name = branchName(input.name);
    const fields = contactFields(input);
    await this.assertNameFree(customerId, name);

    const branch = await this.write(customerId, name, (tx) =>
      this.clearDefaultIf(tx, customerId, input.isDefault === true).then(() =>
        tx.customerBranch.create({
          data: {
            customerId,
            name,
            ...fields,
            isDefault: input.isDefault === true,
          },
        }),
      ),
    );
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'CustomerBranch',
      entityId: branch.id,
      afterJson: branch,
    });
    return { data: branch };
  }

  /** Rename, change the address or phone, make it the default or stop it being one. */
  async update(
    customerId: string,
    branchId: string,
    input: BranchInput,
    actorId: string,
  ) {
    const existing = await this.branch(customerId, branchId);
    const name = input.name === undefined ? undefined : branchName(input.name);
    if (
      name !== undefined &&
      name.toLowerCase() !== existing.name.toLowerCase()
    ) {
      await this.assertNameFree(customerId, name);
    }
    if (input.isDefault === true && existing.archivedAt) {
      throw badRequest(
        'BRANCH_ARCHIVED',
        `The branch ${existing.name} is archived, so it cannot be the default.`,
        { branch: existing.name },
      );
    }
    const fields = contactFields(input);

    const updated = await this.write(customerId, name ?? existing.name, (tx) =>
      this.clearDefaultIf(
        tx,
        customerId,
        input.isDefault === true,
        branchId,
      ).then(() =>
        tx.customerBranch.update({
          where: { id: branchId },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...fields,
            ...(input.isDefault !== undefined
              ? { isDefault: input.isDefault }
              : {}),
          },
        }),
      ),
    );
    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'CustomerBranch',
      entityId: branchId,
      beforeJson: existing,
      afterJson: updated,
    });
    return { data: updated };
  }

  /**
   * Archive: no new orders or payments to it; its orders, balance and statement
   * stay. It stops being the default — an archived branch cannot take the
   * orders the default exists to catch. Archiving twice changes nothing.
   */
  async archive(customerId: string, branchId: string, actorId: string) {
    const existing = await this.branch(customerId, branchId);
    if (existing.archivedAt) return { data: existing };
    const updated = await this.prisma.customerBranch.update({
      where: { id: branchId },
      data: { archivedAt: new Date(), isDefault: false },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'ARCHIVE',
      entityType: 'CustomerBranch',
      entityId: branchId,
      beforeJson: existing,
      afterJson: updated,
    });
    return { data: updated };
  }

  /** Back in use. It does not become the default again by itself. */
  async restore(customerId: string, branchId: string, actorId: string) {
    const existing = await this.branch(customerId, branchId);
    if (!existing.archivedAt) return { data: existing };
    const updated = await this.prisma.customerBranch.update({
      where: { id: branchId },
      data: { archivedAt: null },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'RESTORE',
      entityType: 'CustomerBranch',
      entityId: branchId,
      beforeJson: existing,
      afterJson: updated,
    });
    return { data: updated };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async customer(customerId: string) {
    if (!isUuid(customerId)) throw notFound('customer');
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, isWalkIn: true },
    });
    if (!customer) throw notFound('customer');
    return customer;
  }

  /** The branch, and only through its own customer: another's is not found. */
  private async branch(customerId: string, branchId: string) {
    await this.customer(customerId);
    if (!isUuid(branchId)) throw notFound('customerBranch');
    const branch = await this.prisma.customerBranch.findUnique({
      where: { id: branchId },
    });
    if (!branch || branch.customerId !== customerId) {
      throw notFound('customerBranch');
    }
    return branch;
  }

  private async assertNameFree(customerId: string, name: string) {
    const taken = await this.prisma.customerBranch.findFirst({
      where: { customerId, name: { equals: name, mode: 'insensitive' } },
      select: { name: true },
    });
    if (taken) throw nameTaken(taken.name);
  }

  /** Making one the default first takes it off whichever had it. */
  private async clearDefaultIf(
    tx: Prisma.TransactionClient,
    customerId: string,
    makingDefault: boolean,
    exceptId?: string,
  ) {
    if (!makingDefault) return;
    await tx.customerBranch.updateMany({
      where: {
        customerId,
        isDefault: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  /**
   * The write, in one transaction, with the unique indexes' refusals coded: a
   * name that another save took a moment ago, or two defaults set at once.
   */
  private async write<T>(
    customerId: string,
    name: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const clash = await this.prisma.customerBranch.findFirst({
        where: { customerId, name: { equals: name, mode: 'insensitive' } },
        select: { name: true },
      });
      if (clash) throw nameTaken(clash.name);
      throw conflict(
        'BRANCH_DEFAULT_CHANGED',
        'The default branch was changed at the same moment. Look again and retry.',
      );
    }
  }
}

function nameTaken(existing: string) {
  return badRequest(
    'BRANCH_NAME_TAKEN',
    `This customer already has a branch called ${existing}.`,
    { branch: existing },
  );
}

/** The name, trimmed: required, and not longer than anyone would type. */
export function branchName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    throw badRequest('BRANCH_NAME_REQUIRED', 'A branch needs a name.');
  }
  if (name.length > BRANCH_NAME_MAX) {
    throw badRequest(
      'BRANCH_NAME_TOO_LONG',
      `A branch name can be at most ${BRANCH_NAME_MAX} characters.`,
      { max: BRANCH_NAME_MAX },
    );
  }
  return name;
}

/** Address and phone: trimmed, empty as null, only when sent. */
function contactFields(input: BranchInput) {
  const out: { address?: string | null; phone?: string | null } = {};
  for (const key of ['address', 'phone'] as const) {
    if (input[key] === undefined) continue;
    const v = typeof input[key] === 'string' ? input[key].trim() : '';
    if (v.length > FIELD_MAX) {
      throw badRequest(
        'VALIDATION_FAILED',
        `${key} can be at most ${FIELD_MAX} characters.`,
        { fields: key },
      );
    }
    out[key] = v || null;
  }
  return out;
}
