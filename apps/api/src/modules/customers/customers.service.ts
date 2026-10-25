import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CustomerType, Prisma } from '@prisma/client';
import {
  filterOf,
  listRows,
  type ListQuery,
  pageOfIds,
  searchOf,
  sortOf,
} from '../../common/list-query';
import { searchIds } from '../../common/repositories/list-search';

import { badRequest, notFound } from '../../common/api-error';
import { isUuid } from '../../common/uuid';
import {
  VALUE_NOW_ITEM_INCLUDE,
  withValueNow,
} from '../../common/order-value-now';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
import {
  OWED_STATUSES,
  owedBy,
  owedByEach,
} from '../../common/customer-balance';
import {
  receivablesByCustomer,
  toCollect,
  withOverdue,
} from '../../common/receivables';
import { PaymentPlansService } from '../payment-plans/payment-plans.service';
import { assertNotWalkIn } from '../../common/walk-in';
const CUSTOMER_TYPES = [
  'B2B',
  'B2C',
] as const satisfies readonly CustomerType[];

/** The Customers list's orders; the first is the default. Each ends on `id`. */
const CUSTOMER_SORTS = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
  // Whoever owes the most first; this order breaks ties before the name does.
  balance: [{ createdAt: 'desc' }, { id: 'desc' }],
} satisfies Record<string, Prisma.CustomerOrderByWithRelationInput[]>;

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private paymentPlans: PaymentPlansService,
  ) {}

  /**
   * The Customers list (server-side lists, owner 2026-10-25): searched,
   * filtered, sorted, counted and paged here (`common/list-query.ts`).
   *
   *   search        name, phone or email, Arabic-forgiving
   *   verification  VERIFIED | UNVERIFIED | ALL (omitted hides unverified)
   *   type          B2B | B2C
   *   sort          newest (default) | balance — whoever owes the most first
   */
  async findAll(
    query: ListQuery & {
      type?: string;
      verification?: string;
    },
  ) {
    const { verification } = query;
    const type = filterOf(query.type, 'type', CUSTOMER_TYPES);
    const search = searchOf(query);
    const { key: sort, orderBy } = sortOf(query, CUSTOMER_SORTS);
    // The walk-in record is not a customer anyone chose (BUSINESS_LOGIC §4,
    // 2026-10-11): it is behind every walk-in sale and is reached with the
    // sale form's Walk-in switch, never picked. Every picker reads this list,
    // so leaving it out here leaves it out of all of them. Its sales still
    // count in revenue and the dashboard, which read orders, not this list.
    const where: Prisma.CustomerWhereInput = { isWalkIn: false };
    if (type) where.type = type;

    // Unverified shops are hidden unless asked for.
    //
    // Anyone can create one by filling in the storefront's signup form — the
    // owner's decision of 2026-08-30, taken knowing it puts strangers in the
    // table that orders and balances hang off. They are kept out of the list by
    // default so a morning's spam does not bury the real customers, and shown
    // deliberately through `verification=UNVERIFIED` when someone sits down to
    // work through them.
    //
    // `verification=ALL` is the escape hatch for a search that should find
    // everything, so a name typed into the box does not silently miss an
    // account that exists.
    if (verification === 'UNVERIFIED' || verification === 'VERIFIED') {
      where.verificationStatus = verification;
    } else if (verification !== 'ALL') {
      where.verificationStatus = { not: 'UNVERIFIED' };
    }
    if (search) {
      where.id = {
        in: await searchIds(
          this.prisma,
          `customers t`,
          [`t.display_name`, `t.phone`, `t.email`],
          search,
        ),
      };
    }
    const include = {
      _count: { select: { saleOrders: true, payments: true } },
    } as const;

    // What a customer owes is a sum over their orders, which no ORDER BY on
    // this table can say: every match's balance is worked out (one grouped
    // query), the matches ordered by it, and only the page's rows loaded.
    if (sort === 'balance') {
      const matches = await this.prisma.customer.findMany({
        where,
        orderBy,
        select: { id: true, displayName: true },
      });
      const owedAll = await owedByEach(
        this.prisma,
        matches.map((c) => c.id),
      );
      const ordered = matches
        .map((c) => ({ ...c, owed: Number(owedAll.get(c.id) ?? 0) }))
        .sort(
          (a, b) =>
            b.owed - a.owed || a.displayName.localeCompare(b.displayName),
        )
        .map((c) => c.id);
      const { pageIds, meta } = pageOfIds(ordered, query);
      const rows = await this.prisma.customer.findMany({
        where: { id: { in: pageIds } },
        include,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = pageIds
        .map((id) => byId.get(id)!)
        .map((c) => ({
          ...c,
          outstandingBalance: owedAll.get(c.id) ?? '0.00',
        }));
      return { data, meta };
    }

    const { rows, meta } = await listRows(query, {
      rows: (window) =>
        this.prisma.customer.findMany({ where, orderBy, include, ...window }),
      count: () => this.prisma.customer.count({ where }),
    });
    // The balance column, by the same rule as the customer's own page — one
    // grouped query for the page rather than one per row.
    const owed = await owedByEach(
      this.prisma,
      rows.map((c) => c.id),
    );
    const data = rows.map((c) => ({
      ...c,
      outstandingBalance: owed.get(c.id) ?? '0.00',
    }));
    return { data, meta };
  }

  /**
   * Who owes what: one row per customer with something outstanding, the
   * largest balance first, with how many orders are open and the oldest one
   * still owing (I1, 2026-10-11). The same orders `owedBy` sums, so each row
   * equals that customer's balance on their own page.
   */
  async receivables() {
    const orders = await this.prisma.saleOrder.findMany({
      where: { status: { in: [...OWED_STATUSES] }, outstanding: { gt: 0 } },
      select: {
        customerId: true,
        outstanding: true,
        orderedAt: true,
        customer: {
          select: { displayName: true, phone: true, isWalkIn: true },
        },
      },
    });
    return { data: receivablesByCustomer(orders) };
  }

  /**
   * The dashboard's To collect card (owner, 2026-10-15): the `limit` customers
   * to chase first, overdue before not, then the largest balance, with the
   * totals across everyone owing. The same receivables and the same overdue
   * figure the assistant's list_receivables reads — nothing worked out twice.
   */
  async toCollect(limit = 5) {
    const [{ data: owing }, { data: overdue }] = await Promise.all([
      this.receivables(),
      this.paymentPlans.overdueSummary(),
    ]);
    return { data: toCollect(withOverdue(owing, overdue.plans), limit) };
  }

  async findById(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        saleOrders: {
          // The latest sales by the day they were made (§4, 2026-10-16).
          orderBy: [{ orderedAt: 'desc' }, { createdAt: 'desc' }],
          take: 10,
          include: { items: { include: VALUE_NOW_ITEM_INCLUDE } },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!customer) throw notFound('customer');
    // What the shop owes, by the same rule that refuses a payment larger than
    // it — so the balance shown and the balance enforced cannot disagree.
    const outstandingBalance = await owedBy(this.prisma, id);
    // Each order says what it is worth now, as the Sales list does (§4).
    return {
      data: {
        ...customer,
        saleOrders: customer.saleOrders.map(withValueNow),
        outstandingBalance,
      },
    };
  }

  /**
   * The shop's statement for a range of days (BUSINESS_LOGIC §7b,
   * 2026-10-11): the balance it opened at, every sale, payment, return and
   * reversal in order with a running balance, and the balance it closed at —
   * which, for a range running to today, is the balance on the shop's page.
   */
  async statement(id: string, range: { from?: string; to?: string }) {
    if (!isUuid(id)) throw notFound('customer');
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, displayName: true, phone: true, isWalkIn: true },
    });
    if (!customer) throw notFound('customer');
    // A walk-in buyer has no account to state (§4): every walk-in sale was
    // paid as it was made, and the record is shared by all of them.
    if (customer.isWalkIn) {
      throw badRequest(
        'WALK_IN_NO_STATEMENT',
        'A walk-in buyer has no account, so there is no statement.',
      );
    }
    const source = await loadStatementSource(this.prisma, id);
    return {
      data: buildStatement(
        {
          id: customer.id,
          displayName: customer.displayName,
          phone: customer.phone,
        },
        source,
        { from: range.from || undefined, to: range.to || undefined },
      ),
    };
  }

  async create(
    data: {
      type: 'B2B' | 'B2C';
      displayName: string;
      phone?: string;
      email?: string;
    },
    actorId: string,
  ) {
    const customer = await this.prisma.customer.create({
      data: {
        type: data.type,
        displayName: data.displayName,
        phone: data.phone,
        email: data.email,
        // Verified, because a person in the office just created it.
        //
        // The column defaults to UNVERIFIED, which is the right default for a
        // row that arrives without anyone saying where it came from — and the
        // storefront's self-signup relies on it. But verification means "a
        // person has vetted this account", and that is exactly what happened
        // here. Taking the default made every customer the office added
        // unsellable-to, which forty-four tests said in one run.
        verificationStatus: 'VERIFIED',
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Customer',
      entityId: customer.id,
      afterJson: customer,
    });

    return { data: customer };
  }

  /**
   * Vet a shop that signed itself up.
   *
   * Self-signup writes an UNVERIFIED customer, and every service that moves
   * money refuses one — so without this the account can browse, can ask for an
   * import, and can never become a customer. `update` deliberately does not
   * accept `verificationStatus`: lifting it is a decision a person makes about
   * an account, not a field edited in passing on a form.
   *
   * Idempotent. Verifying twice is a double-click, not an error, and it should
   * not put a second row in the audit log saying nothing changed.
   */
  async verify(id: string, actorId: string) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw notFound('customer');
    assertNotWalkIn(existing);

    if (existing.verificationStatus === 'VERIFIED') return { data: existing };

    const updated = await this.prisma.customer.update({
      where: { id },
      data: { verificationStatus: 'VERIFIED' },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'VERIFY',
      entityType: 'Customer',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  async update(
    id: string,
    data: {
      type?: 'B2B' | 'B2C';
      displayName?: string;
      phone?: string;
      email?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.customer.findUnique({ where: { id } });
    if (!existing) throw notFound('customer');
    assertNotWalkIn(existing);

    const updated = await this.prisma.customer.update({
      where: { id },
      data: {
        type: data.type,
        displayName: data.displayName,
        phone: data.phone,
        email: data.email,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Customer',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }
}
