import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { badRequest, forbidden } from '../../../common/api-error';
import { PrismaService } from '../../../prisma/prisma.service';
import { CATEGORY_CREATE_ROLES } from '../../products/category-roles';
import { ProductsService } from '../../products/products.service';
import { inTransaction } from '../receipt/receipt-writes';
import { matchByName } from '../receipt/name-matching';
import {
  readTool,
  writeTool,
  type AssistantContext,
  type ToolOutcome,
} from '../tool-kit';

/**
 * The category tools (BUSINESS_LOGIC §16, owner 2026-10-15): list_categories
 * (a `readTool`) and create_category (a `writeTool` — previewed, then
 * committed with the confirmation token).
 *
 * create_category goes through `ProductsService.createCategory`, the method
 * the office's New Category form calls, so the name rules, the Arabic rules
 * and the audit row have one definition. The only thing decided here is which
 * category the partner meant by "under Brakes", and that is never a guess: one
 * exact match by id or name (English or Arabic, spelled either way), or a
 * coded refusal.
 */

interface CategoryRow {
  id: string;
  name: string;
  nameAr: string | null;
  parentId: string | null;
  _count?: { products: number; children: number };
}

interface ParentRef {
  id: string;
  name: string;
  nameAr: string | null;
}

/** "Brakes (فرامل)" — the name a partner recognises, in both languages. */
function label(c: { name: string; nameAr: string | null }): string {
  return c.nameAr ? `${c.name} (${c.nameAr})` : c.name;
}

const createShape = {
  // A plain string: a blank name reaches the service and comes back as its
  // own coded refusal, the one the office form gets.
  name: z
    .string()
    .describe('The English name of the new category, as the partner gave it.'),
  // Only what the partner gave, in Arabic (§3, §16, owner 2026-10-14). Never
  // a translation the assistant made up. Left unbounded here so a name past
  // the limit is refused by the service with NAME_AR_TOO_LONG, as the office
  // form is.
  nameAr: z
    .string()
    .optional()
    .describe(
      'The Arabic name, ONLY if the partner wrote or said it. Never translate the English name yourself; leave it out and it stays empty.',
    ),
  parent: z
    .string()
    .optional()
    .describe(
      'The category this one goes under: its id from list_categories, or its English or Arabic name. Leave out for a top-level category.',
    ),
};

export function registerCategoryTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const products = () => ctx.resolve(ProductsService);

  /** The office endpoint's roles (CLAUDE.md §12), not a list of its own. */
  function assertAllowed() {
    if (!(CATEGORY_CREATE_ROLES as readonly string[]).includes(ctx.user.role)) {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Your role does not allow this action.',
        { role: ctx.user.role },
      );
    }
  }

  async function categories(): Promise<CategoryRow[]> {
    return (await products().findCategories()).data;
  }

  /**
   * The parent the partner named, or a refusal. Settled only by the id, or
   * one category whose English or Arabic name is the same once case, spacing
   * and Arabic spelling (ة/ه, أ/ا, the vowel marks) are set aside. Two such
   * categories, or only a close name, are asked about — never picked.
   */
  async function resolveParent(
    parent: string | undefined,
  ): Promise<ParentRef | null> {
    const wanted = parent?.trim();
    if (!wanted) return null;
    const found = matchByName(
      { id: wanted, name: wanted },
      await categories(),
      'product',
    );
    if (found.status === 'matched') {
      const { id, name, nameAr } = found.match.item;
      return { id, name, nameAr };
    }
    if (found.status === 'several') {
      const candidates = found.candidates.map((c) => label(c.item)).join(', ');
      throw badRequest(
        'CATEGORY_PARENT_AMBIGUOUS',
        `"${wanted}" could be more than one category: ${candidates}. Ask the partner which one, then give its id.`,
        { parent: wanted, candidates },
      );
    }
    const closest =
      found.status === 'close' ? label(found.candidates[0].item) : null;
    throw badRequest(
      'CATEGORY_PARENT_NOT_FOUND',
      `No category is called "${wanted}".` +
        (closest
          ? ` The closest is ${closest} — ask the partner whether that is the one.`
          : ' Use list_categories to see the categories there are.'),
      { parent: wanted, closest: closest ?? '' },
    );
  }

  async function write(
    input: { name: string; nameAr?: string; parent?: string },
    mode: 'preview' | 'commit',
  ): Promise<ToolOutcome> {
    assertAllowed();
    const parent = await resolveParent(input.parent);
    const created = await inTransaction(
      ctx.resolve(PrismaService),
      mode,
      async (tx) =>
        (
          await products().createCategory(
            { name: input.name, nameAr: input.nameAr, parentId: parent?.id },
            actor,
            { db: tx },
          )
        ).data,
    );
    const where = parent ? `under ${label(parent)}` : 'at the top level';
    const what = label(created);
    const committed = mode === 'commit';
    return {
      summary: committed
        ? `Created category ${what}, ${where}.`
        : `A new category: ${what}, ${where}.` +
          (created.nameAr ? '' : ' No Arabic name.'),
      data: {
        id: committed ? created.id : null,
        name: created.name,
        nameAr: created.nameAr ?? null,
        parent,
      },
    };
  }

  readTool(
    server,
    'list_categories',
    {
      title: 'List product categories',
      description:
        'Every product category, alphabetically. Returns id, name, nameAr (the Arabic name, null when none was entered — never translate one yourself), the parent it sits under (parentId, parent and parentAr; null for a top-level category) and how many products it holds. Use it to find a categoryId for create_product, or a parent for create_category.',
      inputSchema: {},
    },
    async () => {
      const rows = await categories();
      const byId = new Map(rows.map((c) => [c.id, c]));
      const data = rows.map((c) => {
        const parent = c.parentId ? byId.get(c.parentId) : undefined;
        return {
          id: c.id,
          name: c.name,
          nameAr: c.nameAr ?? null,
          parentId: c.parentId ?? null,
          parent: parent?.name ?? null,
          parentAr: parent?.nameAr ?? null,
          products: c._count?.products ?? 0,
        };
      });
      return {
        summary: `${data.length} categor${data.length === 1 ? 'y' : 'ies'}.\n${JSON.stringify(data)}`,
        data,
      };
    },
  );

  writeTool(
    server,
    ctx,
    'create_category',
    {
      title: 'Create a product category',
      description:
        'Adds a product category, at the top level or under a parent (by id from list_categories, or by its English or Arabic name). ' +
        'Refused when another category has that English or Arabic name, or when the parent is unknown or could be more than one. ' +
        'nameAr takes an Arabic name only when the partner gave it — never a translation of your own; left out, it stays empty. ' +
        'Call without a confirmationToken to preview.',
      inputSchema: createShape,
    },
    {
      preview: (input) => write(input, 'preview'),
      commit: (input) => write(input, 'commit'),
      // The parent a name resolved to is part of what the partner agreed to:
      // if "Brakes" means another category by the time they say yes, the
      // commit is refused rather than filed somewhere they did not see.
      binds: (preview) => (preview.data as { parent: ParentRef | null }).parent,
    },
  );
}
