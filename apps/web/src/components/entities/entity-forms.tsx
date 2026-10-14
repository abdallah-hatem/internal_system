'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { api } from '../../lib/api';
import { Select } from '../ui/select';
import { TextareaField } from '../ui/textarea-field';
import { InputField, FieldLabel } from '../ui/fields';
import { FieldWithQuickCreate } from '../ui/quick-create';
import { localName, otherName } from '../../lib/localized-name';

/**
 * What each record's create form is, in one place.
 *
 * The first version of quick-create carried its own cut-down fields — name for
 * a category, name and country for a supplier. That is a second definition of
 * a form that already exists on the entity's own tab, and the two drift on the
 * first change: add a field to Customers and the `+` beside a sale quietly
 * keeps making customers without it.
 *
 * So the form is defined once and rendered in both places. The tab and the `+`
 * ask for exactly the same things, and a field added here appears in both.
 *
 * Each entry is:
 *
 *   Fields     the inputs, self-sufficient — it fetches whatever options it
 *              needs rather than being handed them, so it works anywhere
 *   toPayload  FormData in, request body out — the same mapping the page's
 *              own submit handler uses
 *   queryKey   the list a picker reads, invalidated after a save
 */

export interface EntityForm {
  endpoint: string;
  queryKey: string[];
  /** Translation namespace the labels come from. */
  namespace: string;
  titleKey: string;
  Fields: (props: { record?: any }) => React.ReactElement;
  toPayload: (fd: FormData) => Record<string, unknown>;
}

const str = (fd: FormData, key: string) => (fd.get(key) as string) || undefined;

/**
 * An Arabic field as sent: what was typed, '' when it was emptied. Sent even
 * when blank, so editing a record and clearing its Arabic name clears it — the
 * API stores '' as null (BUSINESS_LOGIC §3, 2026-10-14).
 */
const arabic = (fd: FormData, key: string) => ((fd.get(key) as string | null) ?? '').trim();

/** The API's limits (apps/api/src/common/arabic-names.ts). */
const NAME_AR_MAX = 200;
const DESCRIPTION_AR_MAX = 1000;

/** A category or product as a picker option: its name for this reader, found by either. */
export function namedOption(
  record: { id: string; name: string; nameAr?: string | null },
  locale: string,
) {
  return {
    value: record.id,
    label: localName(record, locale),
    keywords: otherName(record, locale),
  };
}

// ─── Category ─────────────────────────────────────────────────────────
function CategoryFields({ record }: { record?: any }) {
  const t = useTranslations('categories');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });
  const list: any[] = Array.isArray(categories) ? categories : [];

  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required placeholder={tph('categoryName')} />
      {/* Written in Arabic whatever the page's language, so it runs right to
          left on /en too. */}
      <InputField
        label={t('nameAr')}
        name="nameAr"
        dir="rtl"
        maxLength={NAME_AR_MAX}
        defaultValue={record?.nameAr ?? undefined}
        placeholder={tph('categoryNameAr')}
      />
      <FieldLabel label={t('parentCategory')}>
        <Select
          name="parentId"
          defaultValue={record?.parentId || ''}
          placeholder={t('noParent')}
          searchPlaceholder={tph('searchCategories')}
          clearable
          options={list
            // A category cannot be its own parent, and only top-level ones
            // are offered — the API refuses deeper nesting anyway.
            .filter((c) => !c.parentId && c.id !== record?.id)
            .map((c) => namedOption(c, locale))}
        />
      </FieldLabel>
    </>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────
function ProviderFields({ record }: { record?: any }) {
  const t = useTranslations('providers');
  const tph = useTranslations('placeholders');
  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required placeholder={tph('providerName')} />
      <InputField
        label={t('contactPerson')}
        name="contactPerson"
        defaultValue={record?.contactPerson}
        placeholder={tph('contactPerson')}
      />
      <div className="field-row grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('phone')} name="phone" type="tel" defaultValue={record?.phone} placeholder={tph('phone')} />
        <InputField label={t('email')} name="email" type="email" defaultValue={record?.email} placeholder={tph('email')} />
      </div>
      <TextareaField label={t('notes')} name="notes" defaultValue={record?.notes} placeholder={t('notesPlaceholder')} />
    </>
  );
}

// ─── Customer ─────────────────────────────────────────────────────────
const CUSTOMER_TYPES = ['B2B', 'B2C'] as const;

function CustomerFields({ record }: { record?: any }) {
  const t = useTranslations('customers');
  const tph = useTranslations('placeholders');
  return (
    <>
      <InputField
        label={t('name')}
        name="displayName"
        defaultValue={record?.displayName}
        required
        placeholder={tph('customerName')}
      />
      <FieldLabel label={t('type')} required>
        <Select
          name="type"
          required
          defaultValue={record?.type ?? 'B2B'}
          placeholder={tph('chooseCustomerType')}
          options={CUSTOMER_TYPES.map((v) => ({ value: v, label: t(v.toLowerCase()) }))}
        />
      </FieldLabel>
      <InputField label={t('phone')} name="phone" type="tel" defaultValue={record?.phone} placeholder={tph('phone')} />
      <InputField label={t('email')} name="email" type="email" defaultValue={record?.email} placeholder={tph('email')} />
    </>
  );
}

// ─── Product ──────────────────────────────────────────────────────────
function ProductFields({ record }: { record?: any }) {
  const t = useTranslations('products');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });
  const list: any[] = Array.isArray(categories) ? categories : [];

  // Controlled, so a category made by the `+` beside it can be selected the
  // moment it exists. `defaultValue` cannot: React ignores it after the first
  // render, so the new category would save and the field stay empty.
  const [categoryId, setCategoryId] = useState<string>(record?.categoryId ?? '');

  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required placeholder={tph('productName')} />
      <InputField
        label={t('nameAr')}
        name="nameAr"
        dir="rtl"
        maxLength={NAME_AR_MAX}
        defaultValue={record?.nameAr ?? undefined}
        placeholder={tph('productNameAr')}
      />
      <FieldLabel label={t('category')}>
        {/* The `+` is here even though this form is itself what a `+` opens.
            Leaving it out was an earlier decision of mine to avoid stacking
            modals, and it recreated the dead end one level down: someone adding
            a product from a purchase line, with no categories yet, had to throw
            the purchase order away to make one. */}
        <FieldWithQuickCreate entity="category" onCreated={(c) => setCategoryId(c.id)}>
          <Select
            name="category"
            value={categoryId}
            onChange={setCategoryId}
            placeholder={tph('chooseCategory')}
            searchPlaceholder={tph('searchCategories')}
            options={list.map((c) => namedOption(c, locale))}
          />
        </FieldWithQuickCreate>
      </FieldLabel>
      <TextareaField label={t('description')} name="description" defaultValue={record?.description} placeholder={tph('productDescription')} />
      <TextareaField
        label={t('descriptionAr')}
        name="descriptionAr"
        dir="rtl"
        maxLength={DESCRIPTION_AR_MAX}
        defaultValue={record?.descriptionAr ?? undefined}
        placeholder={tph('productDescriptionAr')}
      />
      <InputField label={t('barcode')} name="barcode" defaultValue={record?.barcode} placeholder={tph('barcode')} />
      <InputField
        label={t('minStock')}
        name="minStock"
        type="number"
        placeholder={tph('minStock')}
        defaultValue={record?.minStock}
      />
    </>
  );
}

// ─── Supplier ─────────────────────────────────────────────────────────
function SupplierFields({ record }: { record?: any }) {
  const t = useTranslations('suppliers');
  const tph = useTranslations('placeholders');
  const contact = record?.contactJson ?? {};
  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required placeholder={tph('supplierName')} />
      <InputField label={t('country')} name="country" defaultValue={record?.country} required placeholder={tph('country')} />
      <div className="field-row grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('phone')} name="phone" type="tel" defaultValue={contact.phone} placeholder={tph('supplierPhone')} />
        <InputField label={t('email')} name="email" type="email" defaultValue={contact.email} placeholder={tph('email')} />
      </div>
      <div className="field-row grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('wechat')} name="wechat" defaultValue={contact.wechat} placeholder={tph('wechat')} />
        <InputField label={t('whatsapp')} name="whatsapp" defaultValue={contact.whatsapp} placeholder={tph('whatsapp')} />
      </div>
      <TextareaField label={t('notes')} name="notes" defaultValue={record?.notes} placeholder={tph('supplierNotes')} />
    </>
  );
}

// ─── Lender ───────────────────────────────────────────────────────────
// A friend who pays a supplier for us (BUSINESS_LOGIC §18). The Lenders tab and
// the `+` beside a lender picker both render this.
function LenderFields({ record }: { record?: { name?: string; phone?: string | null; notes?: string | null } }) {
  const t = useTranslations('lenders');
  const tph = useTranslations('placeholders');
  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required placeholder={tph('lenderName')} />
      <InputField label={t('phone')} name="phone" type="tel" defaultValue={record?.phone ?? undefined} placeholder={tph('phone')} />
      <TextareaField label={t('notes')} name="notes" defaultValue={record?.notes ?? undefined} placeholder={tph('lenderNotes')} />
    </>
  );
}

// ─── The registry ─────────────────────────────────────────────────────
export const ENTITY_FORMS = {
  category: {
    endpoint: '/categories',
    queryKey: ['categories'],
    namespace: 'categories',
    titleKey: 'create',
    Fields: CategoryFields,
    toPayload: (fd) => ({
      name: fd.get('name'),
      nameAr: arabic(fd, 'nameAr'),
      parentId: str(fd, 'parentId'),
    }),
  },
  provider: {
    endpoint: '/providers',
    queryKey: ['providers'],
    namespace: 'providers',
    titleKey: 'create',
    Fields: ProviderFields,
    toPayload: (fd) => ({
      name: fd.get('name'),
      contactPerson: str(fd, 'contactPerson'),
      phone: str(fd, 'phone'),
      email: str(fd, 'email'),
      notes: str(fd, 'notes'),
    }),
  },
  customer: {
    endpoint: '/customers',
    queryKey: ['customers'],
    namespace: 'customers',
    titleKey: 'create',
    Fields: CustomerFields,
    toPayload: (fd) => ({
      displayName: fd.get('displayName'),
      type: fd.get('type'),
      phone: str(fd, 'phone'),
      email: str(fd, 'email'),
    }),
  },
  product: {
    endpoint: '/products',
    queryKey: ['products'],
    namespace: 'products',
    titleKey: 'create',
    Fields: ProductFields,
    toPayload: (fd) => ({
      name: fd.get('name'),
      nameAr: arabic(fd, 'nameAr'),
      categoryId: str(fd, 'category'),
      description: str(fd, 'description'),
      descriptionAr: arabic(fd, 'descriptionAr'),
      barcode: str(fd, 'barcode'),
      minStock: fd.get('minStock') ? Number(fd.get('minStock')) : undefined,
    }),
  },
  supplier: {
    endpoint: '/suppliers',
    queryKey: ['suppliers'],
    namespace: 'suppliers',
    titleKey: 'create',
    Fields: SupplierFields,
    toPayload: (fd) => ({
      name: fd.get('name'),
      country: fd.get('country'),
      contactJson: {
        phone: str(fd, 'phone'),
        email: str(fd, 'email'),
        wechat: str(fd, 'wechat'),
        whatsapp: str(fd, 'whatsapp'),
      },
      notes: str(fd, 'notes'),
    }),
  },
  lender: {
    endpoint: '/lenders',
    queryKey: ['lenders'],
    namespace: 'lenders',
    titleKey: 'create',
    Fields: LenderFields,
    toPayload: (fd) => ({
      name: fd.get('name'),
      phone: str(fd, 'phone'),
      notes: str(fd, 'notes'),
    }),
  },
} satisfies Record<string, EntityForm>;

export type EntityName = keyof typeof ENTITY_FORMS;
