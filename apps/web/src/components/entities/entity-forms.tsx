'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api';
import { Select } from '../ui/select';
import { TextareaField } from '../ui/textarea-field';
import { InputField, FieldLabel } from '../ui/fields';
import { FieldWithQuickCreate } from '../ui/quick-create';

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

// ─── Category ─────────────────────────────────────────────────────────
function CategoryFields({ record }: { record?: any }) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });
  const list: any[] = Array.isArray(categories) ? categories : [];

  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required />
      <FieldLabel label={t('parentCategory')}>
        <Select
          name="parentId"
          defaultValue={record?.parentId || ''}
          placeholder={t('noParent')}
          searchPlaceholder={tc('search')}
          clearable
          options={list
            // A category cannot be its own parent, and only top-level ones
            // are offered — the API refuses deeper nesting anyway.
            .filter((c) => !c.parentId && c.id !== record?.id)
            .map((c) => ({ value: c.id, label: c.name }))}
        />
      </FieldLabel>
    </>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────
function ProviderFields({ record }: { record?: any }) {
  const t = useTranslations('providers');
  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required />
      <InputField
        label={t('contactPerson')}
        name="contactPerson"
        defaultValue={record?.contactPerson}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('phone')} name="phone" type="tel" defaultValue={record?.phone} />
        <InputField label={t('email')} name="email" type="email" defaultValue={record?.email} />
      </div>
      <TextareaField label={t('notes')} name="notes" defaultValue={record?.notes} />
    </>
  );
}

// ─── Customer ─────────────────────────────────────────────────────────
const CUSTOMER_TYPES = ['B2B', 'B2C'] as const;

function CustomerFields({ record }: { record?: any }) {
  const t = useTranslations('customers');
  return (
    <>
      <InputField
        label={t('name')}
        name="displayName"
        defaultValue={record?.displayName}
        required
      />
      <FieldLabel label={t('type')} required>
        <Select
          name="type"
          required
          defaultValue={record?.type ?? 'B2B'}
          options={CUSTOMER_TYPES.map((v) => ({ value: v, label: t(v.toLowerCase()) }))}
        />
      </FieldLabel>
      <InputField label={t('phone')} name="phone" type="tel" defaultValue={record?.phone} />
      <InputField label={t('email')} name="email" type="email" defaultValue={record?.email} />
    </>
  );
}

// ─── Product ──────────────────────────────────────────────────────────
function ProductFields({ record }: { record?: any }) {
  const t = useTranslations('products');
  const tc = useTranslations('common');
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
      <InputField label={t('name')} name="name" defaultValue={record?.name} required />
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
            placeholder={t('category')}
            searchPlaceholder={tc('search')}
            options={list.map((c) => ({ value: c.id, label: c.name }))}
          />
        </FieldWithQuickCreate>
      </FieldLabel>
      <TextareaField label={t('description')} name="description" defaultValue={record?.description} />
      <InputField label={t('barcode')} name="barcode" defaultValue={record?.barcode} />
      <InputField
        label={t('minStock')}
        name="minStock"
        type="number"
        placeholder="0"
        defaultValue={record?.minStock}
      />
    </>
  );
}

// ─── Supplier ─────────────────────────────────────────────────────────
function SupplierFields({ record }: { record?: any }) {
  const t = useTranslations('suppliers');
  const contact = record?.contactJson ?? {};
  return (
    <>
      <InputField label={t('name')} name="name" defaultValue={record?.name} required />
      <InputField label={t('country')} name="country" defaultValue={record?.country} required />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('phone')} name="phone" type="tel" defaultValue={contact.phone} />
        <InputField label={t('email')} name="email" type="email" defaultValue={contact.email} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField label={t('wechat')} name="wechat" defaultValue={contact.wechat} />
        <InputField label={t('whatsapp')} name="whatsapp" defaultValue={contact.whatsapp} />
      </div>
      <TextareaField label={t('notes')} name="notes" defaultValue={record?.notes} />
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
    toPayload: (fd) => ({ name: fd.get('name'), parentId: str(fd, 'parentId') }),
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
      categoryId: str(fd, 'category'),
      description: str(fd, 'description'),
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
} satisfies Record<string, EntityForm>;

export type EntityName = keyof typeof ENTITY_FORMS;
