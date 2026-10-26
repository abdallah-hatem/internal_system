import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  listRows,
  type ListQuery,
  searchOf,
  sortOf,
} from '../../common/list-query';
import { searchIds } from '../../common/repositories/list-search';
import { supplierKey } from '../assistant/receipt/name-matching';

import { badRequest, conflict, notFound } from '../../common/api-error';
import { cyclesVisibleTo, type ScopeViewer } from '../../common/investor-scope';
import { isUuid } from '../../common/uuid';
import { assertCountryCode, countriesContaining } from '../../common/countries';

type Db = Prisma.TransactionClient;

/** The Suppliers list's orders; the first is the default. Each ends on `id`. */
const SUPPLIER_SORTS = {
  name: [{ name: 'asc' }, { id: 'asc' }],
} satisfies Record<string, Prisma.SupplierOrderByWithRelationInput[]>;

@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(query: ListQuery, viewer: ScopeViewer = 'internal') {
    const search = searchOf(query);
    const { orderBy } = sortOf(query, SUPPLIER_SORTS);
    const where: Prisma.SupplierWhereInput = {};
    if (search) {
      // The name, phone or email, Arabic-forgiving (server-side lists, owner
      // 2026-10-25). A country is stored as its code, so "China", "صين" or
      // "CN" finds the suppliers saved as CN; the stored value is searched
      // too, for one the migration could not convert (§21).
      const codes = countriesContaining(search);
      where.OR = [
        {
          id: {
            in: await searchIds(
              this.prisma,
              `suppliers t`,
              [
                `t.name`,
                `t.country`,
                `t.contact_json->>'phone'`,
                `t.contact_json->>'email'`,
              ],
              search,
            ),
          },
        },
        ...(codes.length ? [{ country: { in: codes } }] : []),
      ];
    }
    // An investor: only the suppliers their cycles bought from, and only
    // those orders counted — the rest of the business's buying is not theirs
    // to read (R1).
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const ours = scope === null ? undefined : { cycleId: { in: [...scope] } };
    if (ours) where.purchaseOrders = { some: ours };

    const { rows: data, meta } = await listRows(query, {
      rows: (window) =>
        this.prisma.supplier.findMany({
          where,
          orderBy,
          // The list is what the suppliers page renders, and it needs to know what
          // points at each row: how many orders were bought from it, and whether
          // deleting it is even possible.
          include: {
            products: true,
            _count: {
              select: {
                purchaseOrders: ours ? { where: ours } : true,
                products: true,
              },
            },
          },
          ...window,
        }),
      count: () => this.prisma.supplier.count({ where }),
    });
    return { data, meta };
  }

  async findById(id: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(id)) throw notFound('supplier');
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const ours = scope === null ? undefined : { cycleId: { in: [...scope] } };
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { include: { product: true } },
        purchaseOrders: ours ? { where: ours } : true,
      },
    });
    if (!supplier) throw notFound('supplier');
    // A supplier none of an investor's cycles bought from reads as missing.
    if (ours && supplier.purchaseOrders.length === 0)
      throw notFound('supplier');
    return { data: supplier };
  }

  /**
   * Refuses a name that is already a supplier's, naming the one it is.
   *
   * "The same name" is the receipt matcher's definition, not a new one: case,
   * spacing, punctuation and legal-form words ("Co., Ltd.") ignored. A name
   * the matcher would call the same supplier must not become a second one —
   * the next receipt from it would then match two and settle neither.
   *
   * Called by the assistant before it creates a supplier. The office form does
   * not call it yet: whether the office app refuses duplicate names is a rule
   * nobody has agreed, and suppliers already on file may share one.
   */
  async assertNameFree(name: string, db: Db = this.prisma): Promise<void> {
    const key = supplierKey(name);
    const all = await db.supplier.findMany({
      select: { id: true, name: true },
    });
    const existing = all.find((s) => supplierKey(s.name) === key);
    if (existing) {
      throw conflict(
        'SUPPLIER_NAME_TAKEN',
        `A supplier named ${existing.name} already exists.`,
        { name: existing.name },
      );
    }
  }

  /**
   * `db` is the transaction to create it in, when it is one part of a larger
   * change — a supplier added together with the order bought from it.
   */
  async create(
    data: {
      name: string;
      country: string;
      contactJson?: any;
      notes?: string;
    },
    actorId: string,
    db: Db = this.prisma,
  ) {
    // A code from the one list, upper-cased; refused before anything is
    // written (§21, 2026-10-16).
    const country = assertCountryCode(data.country);
    const supplier = await db.supplier.create({
      data: {
        name: data.name,
        country,
        contactJson: data.contactJson,
        notes: data.notes,
      },
    });

    await this.audit.log(
      {
        actorUserId: actorId,
        action: 'CREATE',
        entityType: 'Supplier',
        entityId: supplier.id,
        afterJson: supplier,
      },
      db,
    );

    return { data: supplier };
  }

  async update(
    id: string,
    data: {
      name?: string;
      country?: string;
      contactJson?: any;
      notes?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.supplier.findUnique({ where: { id } });
    if (!existing) throw notFound('supplier');
    // Left out, the country stays; sent, it must be a code — and sent empty
    // is refused, not stored as no country (§21).
    const country =
      data.country === undefined ? undefined : assertCountryCode(data.country);

    const updated = await this.prisma.supplier.update({
      where: { id },
      data: {
        name: data.name,
        country,
        contactJson: data.contactJson,
        notes: data.notes,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Supplier',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  /**
   * Delete a supplier that nothing points at.
   *
   * A supplier with purchase orders is part of the cycle's cost history — the
   * landed cost of stock still on the shelf traces back through it — so it is
   * kept and the delete refused. This exists for the one created by mistake.
   */
  async remove(id: string, actorId: string) {
    const existing = await this.prisma.supplier.findUnique({
      where: { id },
      include: {
        _count: { select: { purchaseOrders: true, products: true } },
      },
    });
    if (!existing) throw notFound('supplier');

    if (existing._count.purchaseOrders > 0) {
      throw badRequest(
        'SUPPLIER_HAS_ORDERS',
        `Cannot delete supplier: ${existing._count.purchaseOrders} purchase order(s) were bought from it`,
        { count: existing._count.purchaseOrders },
      );
    }
    if (existing._count.products > 0) {
      throw badRequest(
        'SUPPLIER_HAS_PRODUCTS',
        `Cannot delete supplier: ${existing._count.products} product(s) are linked to it`,
        { count: existing._count.products },
      );
    }

    await this.prisma.supplier.delete({ where: { id } });

    await this.audit.log({
      actorUserId: actorId,
      action: 'DELETE',
      entityType: 'Supplier',
      entityId: id,
      beforeJson: existing,
    });

    return { data: { deleted: true } };
  }
}
