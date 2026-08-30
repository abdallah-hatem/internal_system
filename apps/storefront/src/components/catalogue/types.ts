import type { StockBand } from '../ui/stock-badge';

/**
 * The shapes the portal catalogue sends.
 *
 * Written down once, from the API's own response, and deliberately narrow:
 * there is no quantity here and no second price, because the API sends
 * neither. A component cannot render a stock count it was never given, and
 * cannot pick between two tiers when only one arrived.
 */

export type PriceChannel = 'B2B' | 'B2C';

export interface CatalogueItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: { id: string; name: string } | null;
  /** A decimal string the server already resolved for this viewer, or null. */
  price: string | null;
  currency: 'EGP';
  channel: PriceChannel;
  stock: StockBand;
  image: string | null;
}

export interface CataloguePage {
  items: CatalogueItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** Which tier the prices on this page are. Echoed so nothing here decides. */
  channel: PriceChannel;
  /** Null for an anonymous reader. */
  viewer: { verified: boolean } | null;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ProductDetail {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: { id: string; name: string } | null;
  price: string | null;
  currency: 'EGP';
  channel: PriceChannel;
  stock: StockBand;
  fitsModels: string[];
  images: string[];
}
