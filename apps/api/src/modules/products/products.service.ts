import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';

import { badRequest, conflict, notFound } from '../../common/api-error';
import { skuKey } from '../assistant/receipt/name-matching';
import { seesEveryCycle, type ScopeViewer } from '../../common/investor-scope';
import { isUuid } from '../../common/uuid';
import { stockOnHand } from '../../common/low-stock';
import { listPricesFor } from '../../common/default-price';
import {
  lineUnitsSold,
  netUnitsSold,
  SOLD_LINE_WHERE,
  unitsFigure,
} from '../../common/units-sold';
import {
  arabicText,
  bilingualProductSearch,
  DESCRIPTION_AR_MAX,
  NAME_AR_MAX,
  nameArSearchFor,
} from '../../common/arabic-names';
import {
  parseProductStatus,
  type ProductStatus,
} from '../../common/product-status';

type Db = Prisma.TransactionClient;

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(
    pagination: PaginationDto & {
      categoryId?: string;
      status?: string;
      search?: string;
    },
    viewer: ScopeViewer = 'internal',
  ) {
    const {
      cursor,
      limit: rawLimit = 20,
      categoryId,
      status,
      search,
    } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (categoryId) where.categoryId = categoryId;
    if (status) where.status = status;
    // Either language, and the SKU (§3, owner 2026-10-14): "تيل" finds the
    // brake pads whose Arabic name says so, and "خوذه" the "خوذة" (2026-10-15).
    if (search) where.OR = bilingualProductSearch(search);

    const items = await this.prisma.product.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        category: true,
        // The catalogue is shared reference data an investor's cycle pages
        // need; who else the business buys each part from is not (R1).
        suppliers: seesEveryCycle(viewer)
          ? { include: { supplier: true } }
          : false,
        prices: true,
        // How many are in stock (owner, 2026-10-17: "in products table I need
        // to see how many in stock"), by the one stock-on-hand rule the
        // low-stock check uses (common/low-stock.ts). Office only: an
        // investor's view of the catalogue is not a view of the stock.
        ...(seesEveryCycle(viewer)
          ? { inventoryBatches: { select: { remainingQty: true } } }
          : {}),
      },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    // Each channel's price, set or the default landed + markup (§3,
    // owner 2026-10-18) — the one definition, common/default-price.ts.
    const listPrices = await listPricesFor(this.prisma, page);
    const data = page.map(({ inventoryBatches, ...product }) => ({
      ...product,
      listPrices: listPrices.get(product.id)!,
      ...(inventoryBatches ? { onHand: stockOnHand(inventoryBatches) } : {}),
    }));
    return {
      data,
      meta: {
        nextCursor: hasMore ? page[page.length - 1].id : null,
        limit,
      },
    };
  }

  async findById(id: string, viewer: ScopeViewer = 'internal') {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        // The catalogue is shared reference data an investor's cycle pages
        // need; who else the business buys each part from is not (R1).
        suppliers: seesEveryCycle(viewer)
          ? { include: { supplier: true } }
          : false,
        prices: true,
        compatibilities: { include: { motorcycleModel: true } },
      },
    });
    if (!product) throw notFound('product');
    const listPrices = await listPricesFor(this.prisma, [product]);
    return {
      data: {
        ...product,
        listPrices: listPrices.get(product.id)!,
        // Office only, as the stock is: an investor's view of the catalogue
        // is not a view of the business's sales.
        ...(seesEveryCycle(viewer) ? await this.unitsSold(product.id) : {}),
      },
    };
  }

  /**
   * The product page's Units sold card (owner 2026-10-26: "a card to display
   * how many units were sold"): units on realised sales less units returned —
   * the analytics top products' own count (common/units-sold.ts) — and the
   * orders that still hold some of them. One query, whatever the history.
   */
  private async unitsSold(productId: string) {
    const lines = await this.prisma.saleItem.findMany({
      where: { productId, ...SOLD_LINE_WHERE },
      select: {
        saleOrderId: true,
        quantity: true,
        returnItems: { select: { qty: true } },
      },
    });
    // An order counts while it still holds a unit: one handed back entirely
    // sold nothing. GUESS (2026-10-26), the card's second line.
    const perOrder = new Map<string, ReturnType<typeof lineUnitsSold>>();
    for (const line of lines) {
      const held = perOrder.get(line.saleOrderId);
      const units = lineUnitsSold(line);
      perOrder.set(line.saleOrderId, held ? held.add(units) : units);
    }
    return {
      unitsSold: unitsFigure(netUnitsSold(lines)),
      unitsSoldOrders: [...perOrder.values()].filter((u) => u.gt(0)).length,
    };
  }

  /**
   * Refuses a SKU another product already carries, naming that product.
   *
   * Compared as the receipt matcher compares printed codes — case, spaces and
   * dashes ignored — since `ab-12` and `AB 12` are one code on paper, and a
   * second product under it would leave the next receipt matching both.
   */
  async assertSkuFree(sku: string, db: Db = this.prisma): Promise<void> {
    const key = skuKey(sku);
    const all = await db.product.findMany({
      select: { id: true, name: true, sku: true },
    });
    const existing = all.find((p) => skuKey(p.sku) === key);
    if (existing) {
      throw conflict(
        'PRODUCT_SKU_TAKEN',
        `SKU ${sku} is already used by ${existing.name} (${existing.sku}).`,
        { sku, product: existing.name },
      );
    }
  }

  /**
   * `options.sku` is a code printed on a supplier's receipt, which the
   * assistant keeps as the product's SKU so the next receipt matches it. It is
   * an option rather than a field of `data` because `data` is the office
   * form's body as sent, and that form's SKUs are always generated.
   * `options.db` is the transaction to create it in, when there is one.
   */
  async create(
    data: {
      name: string;
      nameAr?: string | null;
      categoryId?: string;
      description?: string;
      descriptionAr?: string | null;
      barcode?: string;
      status?: string;
      minStock?: number;
    },
    actorId: string,
    options: { sku?: string; db?: Db } = {},
  ) {
    const db = options.db ?? this.prisma;
    // Checked before anything is read or numbered: an Arabic name that is too
    // long is refused whatever else is wrong.
    const nameAr = arabicText(data.nameAr, 'nameAr', NAME_AR_MAX);
    const descriptionAr = arabicText(
      data.descriptionAr,
      'descriptionAr',
      DESCRIPTION_AR_MAX,
    );
    // Only ACTIVE or INACTIVE is ever stored (§3, 2026-10-14); a new product
    // with no status is on.
    const status =
      data.status === undefined ? 'ACTIVE' : parseProductStatus(data.status);
    // A category id that is no category failed at the foreign key, deep in
    // Prisma, as "An unexpected error occurred".
    if (data.categoryId) {
      const category = await db.category.findUnique({
        where: { id: data.categoryId },
        select: { id: true },
      });
      if (!category) throw notFound('category');
    }
    const printed = options.sku?.trim();
    let sku: string;
    if (printed) {
      await this.assertSkuFree(printed, db);
      sku = printed;
    } else {
      // Generate SKU: PRD-XXXXXX
      const last = await db.product.findFirst({
        where: { sku: { startsWith: 'PRD-' } },
        orderBy: { sku: 'desc' },
        select: { sku: true },
      });
      sku = `PRD-${pad(nextReferenceNumber(last?.sku, 6), 6)}`;
    }

    const product = await db.product.create({
      data: {
        sku,
        name: data.name,
        nameAr: nameAr ?? null,
        // Written with the name, every time (§3, 2026-10-15): the search reads it.
        nameArSearch: nameArSearchFor(nameAr ?? null),
        categoryId: data.categoryId,
        description: data.description,
        descriptionAr: descriptionAr ?? null,
        barcode: data.barcode,
        status,
        minStock: data.minStock,
      },
      include: { category: true },
    });

    await this.audit.log(
      {
        actorUserId: actorId,
        action: 'CREATE',
        entityType: 'Product',
        entityId: product.id,
        afterJson: product,
      },
      db,
    );

    return { data: product };
  }

  async update(
    id: string,
    data: {
      name?: string;
      nameAr?: string | null;
      categoryId?: string;
      description?: string;
      descriptionAr?: string | null;
      barcode?: string;
      status?: string;
      minStock?: number;
    },
    actorId: string,
  ) {
    // Checked before anything is read: a status nobody may store is refused
    // whether or not the product exists.
    if (data.status !== undefined) parseProductStatus(data.status);
    // Not sent leaves the stored Arabic alone; sent empty clears it.
    const nameAr = arabicText(data.nameAr, 'nameAr', NAME_AR_MAX);
    const descriptionAr = arabicText(
      data.descriptionAr,
      'descriptionAr',
      DESCRIPTION_AR_MAX,
    );
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw notFound('product');

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        nameAr,
        // Moves with the name: left alone when the name is, cleared with it.
        nameArSearch: nameArSearchFor(nameAr),
        categoryId: data.categoryId,
        description: data.description,
        descriptionAr,
        barcode: data.barcode,
        status: data.status,
        minStock: data.minStock,
      },
      include: { category: true },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Product',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  /**
   * Switch a product off, or back on (BUSINESS_LOGIC §3, DECIDED 2026-10-14).
   * Products are never deleted: their orders, batches and settlements point at
   * them. Off, it is offered for no new sale line, purchase-order line or
   * storefront request line; nothing that exists is touched.
   *
   * Setting the status it already has changes nothing and records nothing — a
   * double click is not two decisions.
   */
  async setStatus(id: string, status: unknown, actorId: string) {
    const next: ProductStatus = parseProductStatus(status);
    if (!isUuid(id)) throw notFound('product');
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw notFound('product');
    if (existing.status === next) {
      return { data: { ...existing } };
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: { status: next },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: next === 'INACTIVE' ? 'DEACTIVATE' : 'REACTIVATE',
      entityType: 'Product',
      entityId: id,
      beforeJson: { status: existing.status },
      afterJson: { status: next },
    });

    return { data: updated };
  }

  // ─── Category CRUD ────────────────────────────────────────────

  async findCategories() {
    const categories = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      // The counts drive the list's "N products" badge, which read a
      // `_count` this query never sent (found 2026-10-15).
      include: {
        children: true,
        _count: { select: { products: true, children: true } },
      },
    });
    return { data: categories };
  }

  /**
   * Refuses an Arabic category name another category already carries,
   * ignoring case and surrounding space (§3, owner 2026-10-14) — the same
   * question the partial index `categories_name_ar_key` answers, asked first
   * so the refusal names itself instead of failing at the index.
   */
  private async assertCategoryNameArFree(
    nameAr: string,
    exceptId?: string,
    db: Db = this.prisma,
  ) {
    const dup = await db.category.findFirst({
      where: {
        nameAr: { equals: nameAr, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (dup) {
      throw conflict(
        'CATEGORY_NAME_AR_TAKEN',
        `The Arabic name ${nameAr} is already used by the category ${dup.name}.`,
        { nameAr, category: dup.name },
      );
    }
  }

  /**
   * The one way a category is made — the office's New Category form and the
   * assistant's `create_category` (§16, 2026-10-15) both come here, so the
   * name rules, the Arabic rules and the audit row are the same for both.
   * `options.db` is the transaction to create it in: the assistant's preview
   * runs this very code and rolls it back.
   */
  async createCategory(
    data: { name: string; nameAr?: string | null; parentId?: string | null },
    actorId: string,
    options: { db?: Db } = {},
  ) {
    const db = options.db ?? this.prisma;
    // A blank name was stored as a category called nothing (2026-10-15).
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) {
      throw badRequest('VALIDATION_FAILED', 'A category needs a name.', {
        fields: 'name',
      });
    }
    const nameAr = arabicText(data.nameAr, 'nameAr', NAME_AR_MAX);
    // Unique ignoring case: "brakes" beside "Brakes" is the same category
    // typed twice (§3, 2026-10-15), as for supplier and Arabic names.
    const existing = await db.category.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      throw conflict(
        'CATEGORY_NAME_TAKEN',
        'Category with this name already exists',
      );
    }

    if (nameAr) await this.assertCategoryNameArFree(nameAr, undefined, db);

    // A parent id that is no category failed at the foreign key, deep in
    // Prisma, as "An unexpected error occurred" (CLAUDE.md §1).
    const parentId = data.parentId || undefined;
    if (parentId) {
      const parent = isUuid(parentId)
        ? await db.category.findUnique({
            where: { id: parentId },
            select: { id: true },
          })
        : null;
      if (!parent) throw notFound('category');
    }

    const category = await db.category.create({
      data: {
        name,
        nameAr: nameAr ?? null,
        parentId,
      },
    });

    await this.audit.log(
      {
        actorUserId: actorId,
        action: 'CREATE',
        entityType: 'Category',
        entityId: category.id,
        afterJson: category,
      },
      db,
    );

    return { data: category };
  }

  async findCategoryById(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        children: true,
        parent: true,
        _count: { select: { products: true, children: true } },
      },
    });
    if (!category) throw notFound('category');
    return { data: category };
  }

  async updateCategory(
    id: string,
    data: { name?: string; nameAr?: string | null; parentId?: string | null },
    actorId: string,
  ) {
    const nameAr = arabicText(data.nameAr, 'nameAr', NAME_AR_MAX);
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw notFound('category');
    if (nameAr) await this.assertCategoryNameArFree(nameAr, id);

    // Check name uniqueness if changing
    if (data.name && data.name !== existing.name) {
      // Ignoring case, and not itself: renaming "brakes" to "Brakes" is allowed.
      const dup = await this.prisma.category.findFirst({
        where: {
          name: { equals: data.name.trim(), mode: 'insensitive' },
          NOT: { id },
        },
      });
      if (dup)
        throw conflict(
          'CATEGORY_NAME_TAKEN',
          'Category with this name already exists',
        );
    }

    // Prevent setting self as parent
    if (data.parentId === id) {
      throw badRequest(
        'CATEGORY_OWN_PARENT',
        'Category cannot be its own parent',
      );
    }

    const updated = await this.prisma.category.update({
      where: { id },
      data: { name: data.name, nameAr, parentId: data.parentId },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Category',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  async removeCategory(id: string, actorId: string) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true, children: true } } },
    });
    if (!existing) throw notFound('category');

    if (existing._count.products > 0) {
      throw badRequest(
        'CATEGORY_HAS_PRODUCTS',
        `Cannot delete category with ${existing._count.products} product(s). Reassign or remove them first.`,
        { count: existing._count.products },
      );
    }
    if (existing._count.children > 0) {
      throw badRequest(
        'CATEGORY_HAS_CHILDREN',
        `Cannot delete category with ${existing._count.children} subcategory(ies). Delete or reassign them first.`,
        { count: existing._count.children },
      );
    }

    await this.prisma.category.delete({ where: { id } });

    await this.audit.log({
      actorUserId: actorId,
      action: 'DELETE',
      entityType: 'Category',
      entityId: id,
      beforeJson: existing,
    });

    return { data: { success: true } };
  }

  // ─── Price Management (append-only history) ────────────────────

  async setPrice(
    productId: string,
    data: { channel: string; currency: string; amount: number },
    actorId: string,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw notFound('product');

    // Close previous price for this product+channel
    await this.prisma.productPrice.updateMany({
      where: { productId, channel: data.channel, effectiveTo: null },
      data: { effectiveTo: new Date() },
    });

    const price = await this.prisma.productPrice.create({
      data: {
        productId,
        channel: data.channel,
        currency: data.currency,
        amount: data.amount,
        effectiveFrom: new Date(),
        createdBy: actorId,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'PRICE_CHANGE',
      entityType: 'Product',
      entityId: productId,
      afterJson: price,
    });

    return { data: price };
  }

  async getPriceHistory(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw notFound('product');

    const prices = await this.prisma.productPrice.findMany({
      where: { productId },
      orderBy: { effectiveFrom: 'desc' },
    });

    return { data: prices };
  }
}
