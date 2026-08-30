import { setRequestLocale } from 'next-intl/server';

import { ProductDetail } from '../../../../components/catalogue/product-detail';

/**
 * One product.
 *
 * `sku` arrives already decoded — Next decodes dynamic segments — so decoding
 * it again here would corrupt any SKU that legitimately contains a percent.
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ locale: string; sku: string }>;
}) {
  const { locale, sku } = await params;
  setRequestLocale(locale);

  return <ProductDetail sku={sku} />;
}
