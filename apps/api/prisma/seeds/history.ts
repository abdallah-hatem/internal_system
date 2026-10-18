/**
 * Six months of past trading, May–October 2026, for looking at Analytics and
 * the dashboard with some history behind them (owner, 2026-10-18).
 *
 *   cd apps/api && npm run db:seed:history          writes it
 *   cd apps/api && npm run db:seed:history -- --plan  prints the plan, writes nothing
 *
 * An optional layer on top of any `db:reset` level, or of a database in use. It
 * adds; it never edits or removes what is there, and it depends on nothing
 * already there except the core-partner logins and the walk-in record (which
 * `walkInCustomer` makes if it is missing).
 *
 * How it writes (CLAUDE.md §4). Through the app's own services, called as the
 * API calls them, inside a Nest application context: a cycle is created,
 * funded, its purchase orders placed, its legs depart and deliver, the
 * delivery is received into stock, and only then is anything sold — every
 * back-dated sale draws only stock received by its day, every payment is
 * refused if it is more than the order owes. So each ledger row, allocation,
 * batch and status is the one real use would produce, and every guard runs.
 * Events run in date order, so FIFO takes the oldest stock as it did then.
 *
 * Where a service cannot take a past date, the date field alone is moved
 * afterwards, and only on rows this run wrote (see `backdate`):
 *
 *   - ledger rows a flow writes carry no `occurred_on` and are dated by
 *     `created_at` (schema: "rows a flow writes … read createdAt"): received
 *     payments, stock received, capital put in, returns, a settlement's payout.
 *     Their `created_at` becomes the day it happened;
 *   - stock movements' `occurred_at`, the same way;
 *   - the settlement of the first cycle (`calculated_at`, `approved_at`,
 *     `paid_at`) and that cycle's `closed_on` — settlement is always "now";
 *   - an instalment contract: the service refuses an instalment due in the
 *     past, so it is agreed with the same schedule moved forward and then
 *     moved back (`agreed_on`, `due_on`). That is how one comes to be overdue.
 *
 * Idempotent. Everything it makes is named so it can be found again — cycles
 * `CYC-H26-01…04`, suppliers, products and shops by name, sales by their
 * idempotency key `HIST-S…`, payments by reference `HIST-P…`, purchase orders
 * by their supplier invoice number, expenses by day, category and note — and
 * every step looks first. A second run writes nothing. A run that failed half
 * way resumes where it stopped.
 *
 * Nothing it does reaches anyone: notifications and phone pushes are switched
 * off for the run (these are past events, already dealt with). Do not record
 * real entries in the app while it runs — the back-dating step dates the flow
 * rows written during each step.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { RefundMethod, ShippingCostBasis } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CyclesService } from '../../src/modules/cycles/cycles.service';
import { PurchasesService } from '../../src/modules/purchases/purchases.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { DeliveriesService } from '../../src/modules/shipping/deliveries.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { SalesService } from '../../src/modules/sales/sales.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { PaymentPlansService } from '../../src/modules/payment-plans/payment-plans.service';
import { ReturnsService } from '../../src/modules/returns/returns.service';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { SettlementsService } from '../../src/modules/settlements/settlements.service';
import { LendersService } from '../../src/modules/lenders/lenders.service';
import { ProductsService } from '../../src/modules/products/products.service';
import { SuppliersService } from '../../src/modules/suppliers/suppliers.service';
import { ProvidersService } from '../../src/modules/providers/providers.service';
import { CustomersService } from '../../src/modules/customers/customers.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { PushService } from '../../src/modules/notifications/push.service';
import { businessToday, instantOfDay } from '../../src/common/dates';
import { walkInCustomer } from '../../src/common/walk-in';
import type { CreatePurchaseOrderDto } from '../../src/modules/purchases/dto/create-purchase-order.dto';

// ─── Calendar ─────────────────────────────────────────────────────────────

/** The last day anything in the history happened on. Fixed, so the data is the same whenever it is run. */
const LAST_DAY = '2026-10-17';

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

// ─── A seeded random source, so the plan is the same on every run ─────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260518);
const randInt = (lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
function weighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i;
  }
  return items[items.length - 1];
}
const round10 = (n: number) => Math.round(n / 10) * 10;
const round100 = (n: number) => Math.round(n / 100) * 100;

// ─── What the business deals in ───────────────────────────────────────────

type ProductKey = 'V6' | 'V6D' | 'M2' | 'B35' | 'T2' | 'GLM' | 'GLC' | 'MIC';

interface ProductSpec {
  key: ProductKey;
  name: string;
  nameAr: string;
  category: string;
  description: string;
  minStock: number;
  /** The selling price on each channel, EGP. */
  b2b: number;
  b2c: number;
  /** Price rows set on the product. Left out, the product shows its default (landed + 20%). */
  priced: boolean;
  /** A shop's usual order of it, in units. */
  lot: [number, number];
  /** How often a shop's order has it, relative to the others. */
  weight: number;
}

const PRODUCTS: ProductSpec[] = [
  {
    key: 'V6',
    name: 'RideTalk V6 Pro Helmet Intercom',
    nameAr: 'إنتركم خوذة رايدتوك V6 برو',
    category: 'Helmet Intercoms',
    description: 'Bluetooth intercom for one helmet, 6 riders, 1200 m range.',
    minStock: 10,
    b2b: 2760,
    b2c: 3110,
    priced: true,
    lot: [2, 8],
    weight: 5,
  },
  {
    key: 'V6D',
    name: 'RideTalk V6 Pro Intercom Duo Pack',
    nameAr: 'إنتركم رايدتوك V6 برو - عبوة مزدوجة',
    category: 'Helmet Intercoms',
    description: 'Two paired V6 Pro units, rider and passenger.',
    minStock: 4,
    b2b: 5040,
    b2c: 5670,
    priced: true,
    lot: [1, 4],
    weight: 2,
  },
  {
    key: 'M2',
    name: 'MeshLink M2 Mesh Intercom',
    nameAr: 'إنتركم ميش لينك M2',
    category: 'Helmet Intercoms',
    description: 'Mesh intercom, open group, up to 2 km.',
    minStock: 5,
    b2b: 3950,
    b2c: 4420,
    priced: false,
    lot: [1, 5],
    weight: 3,
  },
  {
    key: 'B35',
    name: 'SoundRide B35 Bluetooth Headset',
    nameAr: 'سماعة خوذة ساوند رايد B35',
    category: 'Helmet Headsets',
    description: 'Helmet headset for music, calls and GPS. No intercom.',
    minStock: 30,
    b2b: 1000,
    b2c: 1130,
    priced: true,
    lot: [6, 24],
    weight: 6,
  },
  {
    key: 'T2',
    name: 'SoundRide T2 Slim Headset',
    nameAr: 'سماعة ساوند رايد T2 النحيفة',
    category: 'Helmet Headsets',
    description: 'Slim speakers for tight helmets, wired remote.',
    minStock: 20,
    b2b: 660,
    b2c: 750,
    priced: false,
    lot: [5, 18],
    weight: 3,
  },
  {
    key: 'GLM',
    name: 'GripLock Aluminium Phone Mount',
    nameAr: 'حامل موبايل جريب لوك ألومنيوم',
    category: 'Phone Mounts',
    description: 'Handlebar phone mount, aluminium, quick release.',
    minStock: 20,
    b2b: 430,
    b2c: 490,
    priced: true,
    lot: [8, 24],
    weight: 4,
  },
  {
    key: 'GLC',
    name: 'GripLock Phone Mount with USB Charger',
    nameAr: 'حامل موبايل جريب لوك بشاحن USB',
    category: 'Phone Mounts',
    description: 'Waterproof mount with a 12 V USB charger.',
    minStock: 10,
    b2b: 770,
    b2c: 870,
    priced: false,
    lot: [4, 12],
    weight: 3,
  },
  {
    key: 'MIC',
    name: 'Helmet Intercom Mic & Speaker Kit',
    nameAr: 'طقم مايك وسماعات للإنتركم',
    category: 'Intercom Accessories',
    description: 'Spare boom mic, wired mic and speakers for V6 / M2.',
    minStock: 30,
    b2b: 230,
    b2c: 270,
    priced: true,
    lot: [10, 36],
    weight: 3,
  },
];
const PRODUCT = new Map(PRODUCTS.map((p) => [p.key, p]));

const CATEGORIES_AR: Record<string, string> = {
  'Helmet Intercoms': 'إنتركم الخوذ',
  'Helmet Headsets': 'سماعات الخوذ',
  'Phone Mounts': 'حوامل الموبايل',
  'Intercom Accessories': 'إكسسوارات الإنتركم',
};

type SupplierKey = 'RT' | 'GL' | 'DMA';
const SUPPLIERS: Record<
  SupplierKey,
  { name: string; country: string; notes: string }
> = {
  RT: {
    name: 'Shenzhen RideTalk Electronics Co.',
    country: 'CN',
    notes: 'Intercoms and headsets. Invoices in USD, 30% deposit.',
  },
  GL: {
    name: 'Guangzhou GripLock Accessories Ltd.',
    country: 'CN',
    notes: 'Phone mounts and intercom spares. Invoices in USD.',
  },
  DMA: {
    name: 'Dubai Moto Accessories FZE',
    country: 'AE',
    notes: 'Stock held in Jebel Ali. Invoices in AED.',
  },
};

type ProviderKey = 'CANTON' | 'DXBCAI';
const PROVIDERS: Record<
  ProviderKey,
  { name: string; contactPerson: string; phone: string }
> = {
  CANTON: {
    name: 'Canton Freight Forwarding',
    contactPerson: 'Leo Chen',
    phone: '+86 20 8555 0192',
  },
  DXBCAI: {
    name: 'Dubai-Cairo Cargo Line',
    contactPerson: 'Walid Samir',
    phone: '+971 4 555 0147',
  },
};

type Habit = 'prompt' | 'split' | 'slow';
interface ShopSpec {
  key: string;
  name: string;
  phone: string;
  habit: Habit;
  weight: number;
  /** No random orders after this day (a shop on an instalment contract keeps its payments to the contract). */
  lastOrder?: string;
}
const SHOPS: ShopSpec[] = [
  {
    key: 'MZ',
    name: 'Moto Zone Nasr City',
    phone: '+20 100 234 5671',
    habit: 'prompt',
    weight: 3,
  },
  {
    key: 'SR',
    name: 'Speed Riders Heliopolis',
    phone: '+20 111 345 6782',
    habit: 'split',
    weight: 3,
  },
  {
    key: 'AH',
    name: 'Al Ahram Bikes Giza',
    phone: '+20 122 456 7893',
    habit: 'slow',
    weight: 2,
  },
  {
    key: 'DM',
    name: 'Delta Moto Mansoura',
    phone: '+20 106 567 8904',
    habit: 'prompt',
    weight: 2,
    lastOrder: '2026-07-01',
  },
  {
    key: 'AR',
    name: 'Alex Riders Smouha',
    phone: '+20 127 678 9015',
    habit: 'prompt',
    weight: 2,
    lastOrder: '2026-08-20',
  },
  {
    key: 'CH',
    name: 'Cairo Helmets Dokki',
    phone: '+20 109 789 0126',
    habit: 'split',
    weight: 2,
  },
  {
    key: 'RS',
    name: 'Red Sea Moto Hurghada',
    phone: '+20 128 890 1237',
    habit: 'slow',
    weight: 1,
  },
  {
    key: 'TB',
    name: 'Tanta Bike Center',
    phone: '+20 115 901 2348',
    habit: 'prompt',
    weight: 1,
  },
];
const SHOP = new Map(SHOPS.map((s) => [s.key, s]));

const LENDER = {
  name: 'Hassan El-Masry',
  phone: '+20 100 555 7788',
  notes: 'Family friend; lends against a purchase order, repaid in pounds.',
};

// ─── The cycles ───────────────────────────────────────────────────────────

interface LegSpec {
  sequence: number;
  origin: string;
  destination: string;
  provider: ProviderKey;
  amount: number;
  currency: string;
  fx: number;
  departedOn?: string;
  /** One delivery of everything on this day. */
  arrivedOn?: string;
  /** Or deliveries in parts: each a day and what came, per product (the rest in the last). */
  deliveries?: { day: string; qty?: Partial<Record<ProductKey, number>> }[];
}
interface CycleSpec {
  key: 'H1' | 'H2' | 'H3' | 'H4';
  code: string;
  originType: 'CHINA' | 'UAE_DIRECT';
  startedOn: string;
  /** Capital each core partner put in, in the order the partners joined. */
  contributions: number[];
  orders: {
    supplier: SupplierKey;
    ref: string;
    orderedOn: string;
    currency: string;
    fx: number;
    lines: [ProductKey, number, number][];
    /** A friend paid this order; repaid later. */
    lender?: {
      amount: number;
      currency: string;
      fx: number;
      paidOn: string;
      repay?: { amountEgp: number; rate: number; paidOn: string };
    };
  }[];
  legs: LegSpec[];
  /** The day each last-leg delivery was counted into stock, in delivery order. */
  receivedOn: string[];
  settleOn?: string;
}

const CN_DXB = { origin: 'Guangzhou, CN', destination: 'Dubai, UAE' };
const DXB_CAI = { origin: 'Dubai, UAE', destination: 'Cairo, Egypt' };

const CYCLES: CycleSpec[] = [
  {
    key: 'H1',
    code: 'CYC-H26-01',
    originType: 'CHINA',
    startedOn: '2026-04-12',
    contributions: [160000, 160000, 160000],
    orders: [
      {
        supplier: 'RT',
        ref: 'RT-26-0413',
        orderedOn: '2026-04-13',
        currency: 'USD',
        fx: 48.6,
        lines: [
          ['V6', 80, 36],
          ['B35', 250, 13],
          ['T2', 150, 8.5],
        ],
      },
      {
        supplier: 'GL',
        ref: 'GL-26-0414',
        orderedOn: '2026-04-14',
        currency: 'USD',
        fx: 48.6,
        lines: [
          ['GLM', 150, 5.5],
          ['MIC', 200, 2.8],
        ],
      },
    ],
    legs: [
      {
        sequence: 1,
        ...CN_DXB,
        provider: 'CANTON',
        amount: 520,
        currency: 'USD',
        fx: 48.9,
        departedOn: '2026-04-24',
        arrivedOn: '2026-05-08',
      },
      {
        sequence: 2,
        ...DXB_CAI,
        provider: 'DXBCAI',
        amount: 1750,
        currency: 'AED',
        fx: 13.3,
        departedOn: '2026-05-12',
        arrivedOn: '2026-05-21',
      },
    ],
    receivedOn: ['2026-05-23'],
    settleOn: '2026-08-25',
  },
  {
    key: 'H2',
    code: 'CYC-H26-02',
    originType: 'UAE_DIRECT',
    startedOn: '2026-06-01',
    contributions: [180000, 120000, 100000],
    orders: [
      {
        supplier: 'DMA',
        ref: 'DMA-2606-114',
        orderedOn: '2026-06-08',
        currency: 'AED',
        fx: 13.4,
        lines: [
          ['V6', 60, 135],
          ['V6D', 30, 245],
          ['B35', 150, 48],
          ['GLM', 100, 20.5],
          ['GLC', 80, 37],
        ],
      },
    ],
    legs: [
      {
        sequence: 1,
        ...DXB_CAI,
        provider: 'DXBCAI',
        amount: 2300,
        currency: 'AED',
        fx: 13.45,
        departedOn: '2026-07-04',
        arrivedOn: '2026-07-13',
      },
    ],
    receivedOn: ['2026-07-15'],
  },
  {
    key: 'H3',
    code: 'CYC-H26-03',
    originType: 'CHINA',
    startedOn: '2026-07-01',
    contributions: [215000, 215000, 215000],
    orders: [
      {
        supplier: 'RT',
        ref: 'RT-26-0706',
        orderedOn: '2026-07-06',
        currency: 'USD',
        fx: 49.8,
        lines: [
          ['V6', 100, 35.5],
          ['V6D', 40, 65],
          ['M2', 50, 52],
          ['B35', 250, 12.8],
        ],
      },
      {
        supplier: 'GL',
        ref: 'GL-26-0708',
        orderedOn: '2026-07-08',
        currency: 'USD',
        fx: 49.8,
        lines: [
          ['GLM', 150, 5.4],
          ['GLC', 100, 9.8],
          ['MIC', 300, 2.7],
          ['T2', 150, 8.3],
        ],
        lender: {
          amount: 3000,
          currency: 'USD',
          fx: 49.8,
          paidOn: '2026-07-08',
          repay: { amountEgp: 100800, rate: 50.4, paidOn: '2026-10-05' },
        },
      },
    ],
    legs: [
      {
        sequence: 1,
        ...CN_DXB,
        provider: 'CANTON',
        amount: 780,
        currency: 'USD',
        fx: 49.9,
        departedOn: '2026-08-04',
        arrivedOn: '2026-08-21',
      },
      {
        sequence: 2,
        ...DXB_CAI,
        provider: 'DXBCAI',
        amount: 2900,
        currency: 'AED',
        fx: 13.55,
        departedOn: '2026-08-26',
        deliveries: [
          {
            day: '2026-09-03',
            qty: {
              V6: 100,
              V6D: 40,
              M2: 50,
              B35: 250,
              GLM: 150,
              GLC: 60,
              MIC: 200,
              T2: 100,
            },
          },
          { day: '2026-09-10' },
        ],
      },
    ],
    receivedOn: ['2026-09-04', '2026-09-11'],
  },
  {
    key: 'H4',
    code: 'CYC-H26-04',
    originType: 'CHINA',
    startedOn: '2026-09-14',
    contributions: [190000, 190000, 190000],
    orders: [
      {
        supplier: 'RT',
        ref: 'RT-26-0916',
        orderedOn: '2026-09-16',
        currency: 'USD',
        fx: 50.4,
        lines: [
          ['V6', 120, 35],
          ['M2', 60, 51],
          ['B35', 300, 12.5],
        ],
      },
    ],
    legs: [
      {
        sequence: 1,
        ...CN_DXB,
        provider: 'CANTON',
        amount: 640,
        currency: 'USD',
        fx: 50.5,
        departedOn: '2026-10-09',
      },
      {
        sequence: 2,
        ...DXB_CAI,
        provider: 'DXBCAI',
        amount: 2600,
        currency: 'AED',
        fx: 13.6,
      },
    ],
    receivedOn: [],
  },
];

// ─── Expenses ─────────────────────────────────────────────────────────────

interface ExpenseSpec {
  day: string;
  category: string;
  amount: number;
  note: string;
  cycle?: CycleSpec['key'];
}

function plannedExpenses(): ExpenseSpec[] {
  const out: ExpenseSpec[] = [];
  const months = [
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
  ];
  const label = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    });
  for (const m of months) {
    const L = label(m);
    out.push({
      day: `${m}-01`,
      category: 'rent',
      amount: 12500,
      note: `Warehouse and office rent, ${L}`,
    });
    out.push({
      day: `${m}-03`,
      category: 'utilities',
      amount: randInt(780, 960),
      note: `Electricity and internet, ${L}`,
    });
    out.push({
      day: `${m}-0${randInt(5, 9)}`,
      category: 'fuel',
      amount: round10(randInt(1100, 1700)),
      note: `Fuel for deliveries, ${L} (first half)`,
    });
    out.push({
      day: `${m}-${randInt(11, 14)}`,
      category: 'packaging',
      amount: round10(randInt(1300, 2600)),
      note: `Cartons, bubble wrap and tape, ${L}`,
    });
    out.push({
      day: `${m}-${randInt(15, 17)}`,
      category: 'transport_delivery',
      amount: round10(randInt(900, 2300)),
      note: `Couriers to shops outside Cairo, ${L}`,
    });
    if (m !== '2026-10') {
      out.push({
        day: `${m}-${randInt(20, 24)}`,
        category: 'fuel',
        amount: round10(randInt(1100, 1800)),
        note: `Fuel for deliveries, ${L} (second half)`,
      });
      out.push({
        day: `${m}-28`,
        category: 'salaries',
        amount: 16000,
        note: `Warehouse assistant and driver, ${L}`,
      });
      out.push({
        day: `${m}-${randInt(25, 27)}`,
        category: 'bank_fees',
        amount: round10(randInt(150, 320)),
        note: `Bank charges, ${L}`,
      });
    }
  }
  out.push({
    day: '2026-06-10',
    category: 'marketing',
    amount: 6000,
    note: 'Facebook and Instagram ads, summer riding season',
  });
  out.push({
    day: '2026-09-15',
    category: 'marketing',
    amount: 4500,
    note: 'Shop posters and demo units for new intercoms',
  });
  // Charged to the cycle they belong to: clearing the goods and getting them to the warehouse.
  out.push({
    day: '2026-05-22',
    category: 'customs_clearance',
    amount: 26500,
    note: 'Customs and clearing agent, Cairo airport',
    cycle: 'H1',
  });
  out.push({
    day: '2026-05-23',
    category: 'extra_freight',
    amount: 3200,
    note: 'Truck from cargo terminal to warehouse',
    cycle: 'H1',
  });
  out.push({
    day: '2026-07-14',
    category: 'customs_clearance',
    amount: 15800,
    note: 'Customs and clearing agent, Cairo airport',
    cycle: 'H2',
  });
  out.push({
    day: '2026-09-03',
    category: 'customs_clearance',
    amount: 31000,
    note: 'Customs and clearing agent, Cairo airport',
    cycle: 'H3',
  });
  out.push({
    day: '2026-09-10',
    category: 'extra_freight',
    amount: 2400,
    note: 'Second truck for the late delivery',
    cycle: 'H3',
  });
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

// ─── The sales plan, simulated against the stock as it arrives ────────────

interface Line {
  product: ProductKey;
  qty: number;
  price: number;
  discount: number;
}
interface SalePlan {
  key: string;
  day: string;
  shop: string | null; // null: a walk-in sale
  lines: Line[];
  kind: 'sale' | 'clearance' | 'contract' | 'cancelled';
  /** How a walk-in buyer paid. */
  method?: string;
  contract?: { instalments: { dueOn: string; amount: number }[] };
}
interface PaymentPlan {
  key: string;
  day: string;
  sale: string;
  /** A share of the order's total, or what is left on it. */
  amount: number | 'rest';
  method: string;
}
interface ReturnPlan {
  key: string;
  day: string;
  sale: string;
  product: ProductKey;
  qty: number;
  restock: boolean;
  refund: RefundMethod;
  reason: string;
}

/** Stock as it would stand, for the plan: per product, batches in arrival order. */
class Shelf {
  private batches = new Map<
    ProductKey,
    { cycle: string; qty: number; day: string }[]
  >();
  receive(product: ProductKey, cycle: string, qty: number, day: string) {
    const list = this.batches.get(product) ?? [];
    list.push({ cycle, qty, day });
    this.batches.set(product, list);
  }
  available(product: ProductKey, day: string) {
    return (this.batches.get(product) ?? [])
      .filter((b) => b.day <= day)
      .reduce((s, b) => s + b.qty, 0);
  }
  take(product: ProductKey, qty: number, day: string) {
    if (qty > this.available(product, day)) {
      throw new Error(
        `plan: ${qty} ${product} wanted on ${day}, only ${this.available(product, day)}`,
      );
    }
    let left = qty;
    for (const b of this.batches.get(product) ?? []) {
      if (left === 0) break;
      if (b.day > day) continue;
      const n = Math.min(b.qty, left);
      b.qty -= n;
      left -= n;
    }
  }
  putBack(product: ProductKey, qty: number) {
    const list = this.batches.get(product) ?? [];
    list[list.length - 1].qty += qty;
  }
  left(product: ProductKey, cycle: string) {
    return (this.batches.get(product) ?? [])
      .filter((b) => b.cycle === cycle)
      .reduce((s, b) => s + b.qty, 0);
  }
}

interface Plan {
  sales: SalePlan[];
  payments: PaymentPlan[];
  returns: ReturnPlan[];
  samples: {
    open: SamplesPlan;
    bought: SamplesPlan & { convertOn: string; keep: Line[] };
    writtenOff: SamplesPlan & { writeOffOn: string };
  };
  expenses: ExpenseSpec[];
}
interface SamplesPlan {
  key: string;
  day: string;
  shop: string;
  lines: Line[];
}

/** Orders per month: shops, then walk-in buyers. Uneven on purpose. */
const MONTHS: { from: string; to: string; shops: number; walkIns: number }[] = [
  { from: '2026-05-24', to: '2026-05-31', shops: 3, walkIns: 1 },
  { from: '2026-06-01', to: '2026-06-30', shops: 12, walkIns: 3 },
  { from: '2026-07-01', to: '2026-07-31', shops: 11, walkIns: 2 },
  { from: '2026-08-01', to: '2026-08-31', shops: 12, walkIns: 3 },
  { from: '2026-09-01', to: '2026-09-30', shops: 15, walkIns: 2 },
  { from: '2026-10-01', to: LAST_DAY, shops: 10, walkIns: 2 },
];

const line = (
  product: ProductKey,
  qty: number,
  channel: 'B2B' | 'B2C',
  discount = 0,
): Line => {
  const p = PRODUCT.get(product)!;
  return { product, qty, price: channel === 'B2B' ? p.b2b : p.b2c, discount };
};

function buildPlan(): Plan {
  const shelf = new Shelf();
  const arrivals: {
    day: string;
    cycle: string;
    product: ProductKey;
    qty: number;
  }[] = [];
  for (const c of CYCLES) {
    const lines = c.orders.flatMap((o) => o.lines);
    const last = c.legs[c.legs.length - 1];
    if (!last.arrivedOn && !last.deliveries) continue;
    const parts = last.deliveries ?? [{ day: last.arrivedOn! }];
    const sent = new Map<ProductKey, number>();
    parts.forEach((part, i) => {
      const day = c.receivedOn[i];
      for (const [product, qty] of lines) {
        const already = sent.get(product) ?? 0;
        const n = part.qty ? (part.qty[product] ?? 0) : qty - already;
        if (n > 0) arrivals.push({ day, cycle: c.key, product, qty: n });
        sent.set(product, already + n);
      }
    });
  }
  arrivals.sort((a, b) => a.day.localeCompare(b.day));

  // Slots: the days orders come in, shop or walk-in, plus the fixed ones.
  type Slot = {
    day: string;
    type: 'shop' | 'walkIn' | 'fixed';
    fixed?: SalePlan;
  };
  const slots: Slot[] = [];
  for (const m of MONTHS) {
    const span = daysBetween(m.from, m.to);
    for (let i = 0; i < m.shops; i++)
      slots.push({ day: addDays(m.from, randInt(0, span)), type: 'shop' });
    for (let i = 0; i < m.walkIns; i++)
      slots.push({ day: addDays(m.from, randInt(0, span)), type: 'walkIn' });
  }
  const fixed: SalePlan[] = [
    {
      key: 'HIST-S-DM-CONTRACT',
      day: '2026-07-20',
      shop: 'DM',
      kind: 'contract',
      lines: [
        line('V6', 6, 'B2B'),
        line('B35', 20, 'B2B'),
        line('GLM', 15, 'B2B'),
      ],
      contract: {
        instalments: ['2026-08-20', '2026-09-20', '2026-10-20'].map(
          (dueOn) => ({ dueOn, amount: 0 }),
        ),
      },
    },
    {
      key: 'HIST-S-AR-CONTRACT',
      day: '2026-09-12',
      shop: 'AR',
      kind: 'contract',
      lines: [
        line('V6D', 4, 'B2B'),
        line('B35', 12, 'B2B'),
        line('GLC', 10, 'B2B'),
      ],
      contract: {
        instalments: ['2026-10-12', '2026-11-12', '2026-12-12'].map(
          (dueOn) => ({ dueOn, amount: 0 }),
        ),
      },
    },
  ];
  for (const f of fixed) {
    // The whole order on instalments, equal to the pound; the last takes the odd amount.
    const owed = f.lines.reduce((t, l) => t + l.qty * l.price - l.discount, 0);
    const inst = f.contract!.instalments;
    const each = Math.floor(owed / inst.length / 5) * 5;
    inst.forEach(
      (x, i) =>
        (x.amount =
          i === inst.length - 1 ? owed - each * (inst.length - 1) : each),
    );
    slots.push({ day: f.day, type: 'fixed', fixed: f });
  }
  // The clearance of the first cycle: whatever of it is left, on this day.
  const CLEARANCE_DAY = '2026-08-20';
  slots.push({ day: CLEARANCE_DAY, type: 'fixed' });
  slots.sort(
    (a, b) => a.day.localeCompare(b.day) || (a.type === 'fixed' ? -1 : 1),
  );

  const sales: SalePlan[] = [];
  let arrivalAt = 0;
  let n = 0;
  const receiveUpTo = (day: string) => {
    while (arrivalAt < arrivals.length && arrivals[arrivalAt].day <= day) {
      const a = arrivals[arrivalAt++];
      shelf.receive(a.product, a.cycle, a.qty, a.day);
    }
  };
  const nextKey = () => `HIST-S${String(++n).padStart(3, '0')}`;

  for (const slot of slots) {
    receiveUpTo(slot.day);
    if (slot.type === 'fixed' && slot.fixed) {
      for (const l of slot.fixed.lines) shelf.take(l.product, l.qty, slot.day);
      sales.push(slot.fixed);
      continue;
    }
    if (slot.type === 'fixed') {
      // Clearance: every unit of the first cycle still on the shelf, to one shop at 12% off.
      const lines: Line[] = [];
      for (const p of PRODUCTS) {
        const left = shelf.left(p.key, 'H1');
        if (left <= 0) continue;
        const l = line(p.key, left, 'B2B');
        l.discount = round10(l.price * left * 0.12);
        lines.push(l);
        shelf.take(p.key, left, slot.day);
      }
      if (lines.length)
        sales.push({
          key: 'HIST-S-CLEARANCE',
          day: slot.day,
          shop: 'CH',
          lines,
          kind: 'clearance',
        });
      continue;
    }
    if (slot.type === 'walkIn') {
      const stocked = PRODUCTS.filter(
        (p) => shelf.available(p.key, slot.day) >= 2,
      );
      if (stocked.length === 0) continue;
      const p = weighted(stocked);
      const qty = Math.min(
        ['GLM', 'MIC'].includes(p.key) ? randInt(1, 3) : randInt(1, 2),
        shelf.available(p.key, slot.day),
      );
      shelf.take(p.key, qty, slot.day);
      sales.push({
        key: nextKey(),
        day: slot.day,
        shop: null,
        lines: [line(p.key, qty, 'B2C')],
        kind: 'sale',
        method: pick(['CASH', 'CASH', 'MOBILE_WALLET']),
      });
      continue;
    }
    // A shop's order.
    const shops = SHOPS.filter((s) => !s.lastOrder || slot.day <= s.lastOrder);
    const shop = weighted(shops);
    const lines: Line[] = [];
    const count = rand() < 0.35 ? 1 : rand() < 0.6 ? 2 : 3;
    const tried = new Set<ProductKey>();
    for (let i = 0; i < count * 3 && lines.length < count; i++) {
      const candidates = PRODUCTS.filter(
        (p) =>
          !tried.has(p.key) && shelf.available(p.key, slot.day) >= p.lot[0],
      );
      if (candidates.length === 0) break;
      const p = weighted(candidates);
      tried.add(p.key);
      const qty = Math.min(
        randInt(p.lot[0], p.lot[1]),
        shelf.available(p.key, slot.day),
      );
      const l = line(p.key, qty, 'B2B');
      // A few shops talk the price down on a big line.
      if (qty * l.price > 15000 && rand() < 0.3)
        l.discount = round10(qty * l.price * (randInt(3, 7) / 100));
      shelf.take(p.key, qty, slot.day);
      lines.push(l);
    }
    if (lines.length === 0) continue;
    sales.push({
      key: nextKey(),
      day: slot.day,
      shop: shop.key,
      lines,
      kind: 'sale',
    });
  }

  // One order cancelled: the shop changed its mind the same week (October, so no settled cycle is touched).
  const cancelled = sales.find(
    (s) => s.day >= '2026-10-01' && s.shop && s.kind === 'sale',
  );
  if (cancelled) {
    cancelled.kind = 'cancelled';
    for (const l of cancelled.lines) shelf.putBack(l.product, l.qty);
  }

  // Returns: two dead headsets from a slow shop in July (not restocked, taken off its balance), and an
  // intercom sent back in September because the wrong model was ordered (restocked, cash refunded).
  const returns: ReturnPlan[] = [];
  const dead = sales.find(
    (s) =>
      s.kind === 'sale' &&
      s.day >= '2026-07-01' &&
      s.shop &&
      SHOP.get(s.shop)!.habit === 'slow' &&
      s.lines.some((l) => l.product === 'B35' && l.qty >= 3),
  );
  if (dead)
    returns.push({
      key: 'HIST-R1',
      day: addDays(dead.day, 9),
      sale: dead.key,
      product: 'B35',
      qty: 2,
      restock: false,
      refund: 'CREDIT_NOTE',
      reason: 'Two headsets dead on arrival - no power',
    });
  const wrong = sales.find(
    (s) =>
      s.kind === 'sale' &&
      s.day >= '2026-09-01' &&
      s.shop &&
      s.lines.some((l) => l.product === 'V6'),
  );
  if (wrong) {
    returns.push({
      key: 'HIST-R2',
      day: addDays(wrong.day, 12),
      sale: wrong.key,
      product: 'V6',
      qty: 1,
      restock: true,
      refund: 'CASH',
      reason: 'Shop ordered the wrong model; unit unopened',
    });
    shelf.putBack('V6', 1);
  }

  // Payments, by each shop's habit. Anything falling after the last day has not been paid yet.
  const payments: PaymentPlan[] = [];
  let p = 0;
  const pay = (
    sale: SalePlan,
    day: string,
    amount: number | 'rest',
    method: string,
  ) => {
    if (day > LAST_DAY) return;
    payments.push({
      key: `HIST-P${String(++p).padStart(3, '0')}`,
      day,
      sale: sale.key,
      amount,
      method,
    });
  };
  const total = (s: SalePlan) =>
    s.lines.reduce((t, l) => t + l.qty * l.price - l.discount, 0);
  for (const s of sales) {
    if (!s.shop || s.kind === 'cancelled') continue;
    if (s.kind === 'contract') {
      // Only the first instalment comes in.
      pay(
        s,
        addDays(s.contract!.instalments[0].dueOn, -1),
        s.contract!.instalments[0].amount,
        'BANK_TRANSFER',
      );
      continue;
    }
    if (s.kind === 'clearance') {
      pay(s, addDays(s.day, 10), round100(total(s) / 2), 'BANK_TRANSFER');
      pay(s, addDays(s.day, 38), 'rest', 'BANK_TRANSFER');
      continue;
    }
    const returned = returns.find((r) => r.sale === s.key);
    const habit = SHOP.get(s.shop)!.habit;
    const method = pick([
      'BANK_TRANSFER',
      'BANK_TRANSFER',
      'CASH',
      'CHEQUE',
      'MOBILE_WALLET',
    ]);
    if (habit === 'prompt') {
      pay(s, addDays(s.day, randInt(3, 9)), 'rest', method);
    } else if (habit === 'split') {
      pay(s, addDays(s.day, randInt(6, 14)), round100(total(s) / 2), method);
      pay(s, addDays(s.day, randInt(28, 42)), 'rest', method);
    } else {
      // A slow shop pays part late and the rest much later; the return comes before any of it.
      const first = Math.max(
        randInt(18, 30),
        returned ? daysBetween(s.day, returned.day) + 1 : 0,
      );
      pay(
        s,
        addDays(s.day, first),
        round100(total(s) * (randInt(35, 55) / 100)),
        method,
      );
      pay(s, addDays(s.day, randInt(60, 80)), 'rest', method);
    }
  }
  payments.sort((a, b) => a.day.localeCompare(b.day));

  // Samples at shops (§4), all recent: one still out, one bought, one written off.
  const samples: Plan['samples'] = {
    writtenOff: {
      key: 'HIST-SMP-RS',
      day: '2026-09-25',
      shop: 'RS',
      lines: [line('B35', 3, 'B2B')],
      writeOffOn: '2026-10-10',
    },
    bought: {
      key: 'HIST-SMP-TB',
      day: '2026-10-02',
      shop: 'TB',
      lines: [line('M2', 2, 'B2B'), line('GLC', 3, 'B2B')],
      convertOn: '2026-10-09',
      keep: [line('M2', 2, 'B2B'), line('GLC', 2, 'B2B')],
    },
    open: {
      key: 'HIST-SMP-MZ',
      day: '2026-10-13',
      shop: 'MZ',
      lines: [line('V6', 2, 'B2B'), line('B35', 4, 'B2B')],
    },
  };
  for (const s of [samples.writtenOff, samples.bought, samples.open]) {
    receiveUpTo(s.day);
    for (const l of s.lines) shelf.take(l.product, l.qty, s.day);
  }
  shelf.putBack('GLC', 1);

  for (const p2 of PRODUCTS) {
    if (shelf.left(p2.key, 'H1') !== 0)
      throw new Error(
        `plan: ${shelf.left(p2.key, 'H1')} ${p2.key} of the first cycle left at settlement`,
      );
  }
  return { sales, payments, returns, samples, expenses: plannedExpenses() };
}

function printPlan(plan: Plan) {
  const byMonth = new Map<
    string,
    { shops: number; walkIns: number; revenue: number }
  >();
  for (const s of plan.sales) {
    if (s.kind === 'cancelled') continue;
    const m = s.day.slice(0, 7);
    const row = byMonth.get(m) ?? { shops: 0, walkIns: 0, revenue: 0 };
    if (s.shop) row.shops++;
    else row.walkIns++;
    row.revenue += s.lines.reduce(
      (t, l) => t + l.qty * l.price - l.discount,
      0,
    );
    byMonth.set(m, row);
  }
  const exp = new Map<string, number>();
  for (const e of plan.expenses)
    exp.set(e.day.slice(0, 7), (exp.get(e.day.slice(0, 7)) ?? 0) + e.amount);
  console.log('month     shops walk-ins   revenue   expenses');
  for (const [m, r] of [...byMonth.entries()].sort()) {
    console.log(
      `${m}   ${String(r.shops).padStart(5)} ${String(r.walkIns).padStart(8)} ${String(Math.round(r.revenue)).padStart(9)} ${String(exp.get(m) ?? 0).padStart(10)}`,
    );
  }
  const sold = new Map<string, number>();
  for (const s of plan.sales)
    if (s.kind !== 'cancelled')
      for (const l of s.lines)
        sold.set(l.product, (sold.get(l.product) ?? 0) + l.qty);
  const got = new Map<string, number>();
  for (const c of CYCLES)
    if (c.receivedOn.length)
      for (const o of c.orders)
        for (const [k, q] of o.lines) got.set(k, (got.get(k) ?? 0) + q);
  console.log(
    PRODUCTS.map(
      (p) => `${p.key} ${sold.get(p.key) ?? 0}/${got.get(p.key) ?? 0}`,
    ).join('  '),
  );
  console.log(
    `${plan.sales.length} orders (${plan.sales.filter((s) => s.kind === 'cancelled').length} cancelled), ${plan.payments.length} payments, ${plan.returns.length} returns, ${plan.expenses.length} expenses`,
  );
}

// ─── Running it through the app ───────────────────────────────────────────

type Step = {
  day: string;
  rank: number;
  label: string;
  run: () => Promise<void>;
};

async function main() {
  const plan = buildPlan();
  if (process.argv.includes('--plan')) {
    printPlan(plan);
    return;
  }

  const url = process.env.DATABASE_URL ?? '';
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `Refusing to write invented history to ${host || 'an unknown database'}: this is for a local database only.`,
    );
  }
  console.log(`History seed → ${url.replace(/\/\/[^@]*@/, '//')}`);

  const app: INestApplicationContext =
    await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
    });
  try {
    await run(app, plan);
  } finally {
    await app.close();
  }
}

async function run(app: INestApplicationContext, plan: Plan) {
  const db = app.get(PrismaService);
  const cycles = app.get(CyclesService);
  const purchases = app.get(PurchasesService);
  const shipping = app.get(ShippingService);
  const deliveries = app.get(DeliveriesService);
  const inventory = app.get(InventoryService);
  const sales = app.get(SalesService);
  const payments = app.get(PaymentsService);
  const plans = app.get(PaymentPlansService);
  const returns = app.get(ReturnsService);
  const ledger = app.get(LedgerService);
  const settlements = app.get(SettlementsService);
  const lenders = app.get(LendersService);
  const products = app.get(ProductsService);
  const suppliers = app.get(SuppliersService);
  const providers = app.get(ProvidersService);
  const customers = app.get(CustomersService);

  // Past events reach nobody: no bell rows, no phone pushes.
  const notifications = app.get(NotificationsService);
  notifications.create = () => Promise.resolve(undefined as never);
  notifications.createForMultipleUsers = () =>
    Promise.resolve(undefined as never);
  const push = app.get(PushService);
  push.sendToUsers = () => Promise.resolve(undefined as never);

  const partners = await db.user.findMany({
    where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });
  if (partners.length === 0)
    throw new Error(
      'No active core partner to record the history as. Run a db:reset level first.',
    );
  const actor = partners[0].id;
  const actorFor = (i: number) => partners[i % partners.length].id;
  const written = { created: 0 };
  const did = (what: string) => {
    written.created++;
    console.log(`  + ${what}`);
  };

  /**
   * Move the date of the flow-written rows a step just wrote to the day it
   * happened: ledger rows that have no occurred_on, and stock movements.
   */
  const backdate = async (since: Date, day: string) => {
    const at = instantOfDay(day);
    await db.financialTransaction.updateMany({
      where: { createdAt: { gte: since }, occurredOn: null },
      data: { createdAt: at },
    });
    await db.inventoryMovement.updateMany({
      where: { occurredAt: { gte: since } },
      data: { occurredAt: at },
    });
  };

  // ── Reference rows: looked up by name, made when missing ──────────────
  const categoryId = new Map<string, string>();
  for (const name of new Set(PRODUCTS.map((p) => p.category))) {
    const found = await db.category.findUnique({ where: { name } });
    if (found) {
      categoryId.set(name, found.id);
      continue;
    }
    const made = await products.createCategory(
      { name, nameAr: CATEGORIES_AR[name] },
      actor,
    );
    categoryId.set(name, made.data.id);
    did(`category ${name}`);
  }
  const productId = new Map<ProductKey, string>();
  for (const p of PRODUCTS) {
    const found = await db.product.findFirst({ where: { name: p.name } });
    if (found) {
      productId.set(p.key, found.id);
      continue;
    }
    const made = await products.create(
      {
        name: p.name,
        nameAr: p.nameAr,
        categoryId: categoryId.get(p.category),
        description: p.description,
        minStock: p.minStock,
      },
      actor,
    );
    productId.set(p.key, made.data.id);
    did(`product ${p.name}`);
    if (p.priced) {
      await products.setPrice(
        made.data.id,
        { channel: 'B2B', currency: 'EGP', amount: p.b2b },
        actor,
      );
      await products.setPrice(
        made.data.id,
        { channel: 'B2C', currency: 'EGP', amount: p.b2c },
        actor,
      );
    }
  }
  const supplierId = new Map<SupplierKey, string>();
  for (const [key, s] of Object.entries(SUPPLIERS) as [
    SupplierKey,
    (typeof SUPPLIERS)[SupplierKey],
  ][]) {
    const found = await db.supplier.findFirst({ where: { name: s.name } });
    if (found) {
      supplierId.set(key, found.id);
      continue;
    }
    const made = await suppliers.create(
      { name: s.name, country: s.country, notes: s.notes },
      actor,
    );
    supplierId.set(key, made.data.id);
    did(`supplier ${s.name}`);
  }
  const providerId = new Map<ProviderKey, string>();
  for (const [key, s] of Object.entries(PROVIDERS) as [
    ProviderKey,
    (typeof PROVIDERS)[ProviderKey],
  ][]) {
    const found = await db.provider.findFirst({ where: { name: s.name } });
    if (found) {
      providerId.set(key, found.id);
      continue;
    }
    const made = await providers.create(s, actor);
    providerId.set(key, made.data.id);
    did(`shipping company ${s.name}`);
  }
  const shopId = new Map<string, string>();
  for (const s of SHOPS) {
    const found = await db.customer.findFirst({
      where: { displayName: s.name },
    });
    if (found) {
      shopId.set(s.key, found.id);
      continue;
    }
    const made = await customers.create(
      { type: 'B2B', displayName: s.name, phone: s.phone },
      actor,
    );
    shopId.set(s.key, made.data.id);
    did(`shop ${s.name}`);
  }
  await walkInCustomer(db);
  let lenderId = (
    await db.lender.findFirst({ where: { name: LENDER.name, deletedAt: null } })
  )?.id;
  if (!lenderId) {
    lenderId = (await lenders.create(LENDER, actor)).data.id;
    did(`lender ${LENDER.name}`);
  }

  // ── The timeline ───────────────────────────────────────────────────────
  const steps: Step[] = [];
  const at = (
    day: string,
    rank: number,
    label: string,
    fn: () => Promise<void>,
  ) => steps.push({ day, rank, label, run: fn });

  const cycleIdOf = new Map<string, string>();
  const cycleId = async (c: CycleSpec) => {
    const known = cycleIdOf.get(c.key);
    if (known) return known;
    const found = await db.importCycle.findUnique({ where: { code: c.code } });
    if (!found) throw new Error(`${c.code} not created yet`);
    cycleIdOf.set(c.key, found.id);
    return found.id;
  };
  const poItems = async (cid: string) =>
    db.purchaseOrderItem.findMany({
      where: { purchaseOrder: { cycleId: cid } },
      select: { id: true, productId: true, orderedQty: true },
    });

  for (const c of CYCLES) {
    at(c.startedOn, 0, `${c.code} started`, async () => {
      let cycle = await db.importCycle.findUnique({ where: { code: c.code } });
      if (!cycle) {
        cycle = (
          await cycles.create(
            {
              code: c.code,
              originType: c.originType,
              currency: 'EGP',
              startedOn: c.startedOn,
            },
            actor,
          )
        ).data;
        did(`cycle ${c.code}`);
      }
      cycleIdOf.set(c.key, cycle.id);
      if (cycle.status === 'PLANNING')
        await cycles.transition(cycle.id, 'FUNDING', actor);
      const participants = await db.cycleParticipant.findMany({
        where: { cycleId: cycle.id, participantType: 'CORE_PARTNER' },
        orderBy: { createdAt: 'asc' },
      });
      for (const [i, p] of participants.entries()) {
        const want =
          c.contributions[i] ?? c.contributions[c.contributions.length - 1];
        if (Number(p.contributionAmount) === want) continue;
        await cycles.updateParticipant(
          p.id,
          { contributionAmount: want },
          actor,
        );
        did(`${c.code}: capital ${want} from partner ${i + 1}`);
      }
      const now = await db.importCycle.findUniqueOrThrow({
        where: { id: cycle.id },
      });
      if (now.status === 'FUNDING')
        await cycles.transition(cycle.id, 'PURCHASING', actor);
    });

    for (const o of c.orders) {
      at(o.orderedOn, 0, `${c.code} order ${o.ref}`, async () => {
        const cid = await cycleId(c);
        let po = await db.purchaseOrder.findFirst({
          where: { cycleId: cid, supplierInvoiceRef: o.ref },
        });
        if (!po) {
          const dto: CreatePurchaseOrderDto = {
            supplierId: supplierId.get(o.supplier)!,
            currency: o.currency,
            fxRateToEgp: o.fx,
            orderedOn: o.orderedOn,
            supplierInvoiceRef: o.ref,
            items: o.lines.map(([k, qty, unitPrice]) => ({
              productId: productId.get(k)!,
              orderedQty: qty,
              unitPrice,
            })),
          };
          po = (await purchases.create(cid, dto, actor)).data;
          did(`${c.code}: purchase order ${o.ref}`);
        }
        if (o.lender) {
          const standing = await db.lenderFinancing.findFirst({
            where: { purchaseOrderId: po.id, removedAt: null },
          });
          if (!standing) {
            await lenders.finance(
              po.id,
              {
                lenderId: lenderId,
                amount: o.lender.amount,
                currency: o.lender.currency,
                fxRateToEgp: o.lender.fx,
                paidOn: o.lender.paidOn,
                note: 'Paid the supplier directly',
              },
              actor,
            );
            did(
              `${c.code}: ${LENDER.name} paid ${o.lender.amount} ${o.lender.currency} of ${o.ref}`,
            );
          }
        }
      });
      const repay = o.lender?.repay;
      if (repay) {
        at(repay.paidOn, 1, `${c.code} repay ${LENDER.name}`, async () => {
          const cid = await cycleId(c);
          const po = await db.purchaseOrder.findFirstOrThrow({
            where: { cycleId: cid, supplierInvoiceRef: o.ref },
          });
          const f = await db.lenderFinancing.findFirstOrThrow({
            where: { purchaseOrderId: po.id, removedAt: null },
          });
          const done = await db.lenderRepayment.findFirst({
            where: {
              financingId: f.id,
              paidOn: new Date(`${repay.paidOn}T00:00:00Z`),
              reversedAt: null,
            },
          });
          if (done) return;
          await lenders.repay(
            f.id,
            {
              amountEgp: repay.amountEgp,
              rateToEgp: repay.rate,
              paidOn: repay.paidOn,
              note: 'Bank transfer',
            },
            actor,
          );
          did(`${c.code}: repaid ${LENDER.name} ${repay.amountEgp} EGP`);
        });
      }
    }

    // Legs are added in order. One that has not left yet is added with the leg before it.
    let legDay = c.orders[c.orders.length - 1].orderedOn;
    for (const leg of c.legs) {
      legDay = leg.departedOn ?? legDay;
      const firstDay = legDay;
      at(firstDay, 0, `${c.code} leg ${leg.sequence}`, async () => {
        const cid = await cycleId(c);
        const found = await db.shippingLeg.findFirst({
          where: { cycleId: cid, sequence: leg.sequence },
        });
        if (found) return;
        const costBasis: ShippingCostBasis = 'FLAT';
        await shipping.createLeg(
          cid,
          {
            sequence: leg.sequence,
            origin: leg.origin,
            destination: leg.destination,
            providerId: providerId.get(leg.provider),
            provider: PROVIDERS[leg.provider].name,
            costBasis,
            amount: leg.amount,
            currency: leg.currency,
            fxRateToEgp: leg.fx,
            departedOn: leg.departedOn,
            arrivedOn: leg.arrivedOn,
          },
          actor,
        );
        did(
          `${c.code}: leg ${leg.origin} → ${leg.destination}${leg.departedOn ? `, left ${leg.departedOn}` : ''}${leg.arrivedOn ? `, arrived ${leg.arrivedOn}` : ''}`,
        );
      });
      for (const [i, part] of (leg.deliveries ?? []).entries()) {
        at(
          part.day,
          0,
          `${c.code} leg ${leg.sequence} delivery ${i + 1}`,
          async () => {
            const cid = await cycleId(c);
            const l = await db.shippingLeg.findFirstOrThrow({
              where: { cycleId: cid, sequence: leg.sequence },
            });
            const already = await db.shipmentDelivery.findFirst({
              where: {
                legId: l.id,
                arrivedOn: new Date(`${part.day}T00:00:00Z`),
              },
            });
            if (already) return;
            const items = await poItems(cid);
            const delivered = await db.shipmentDeliveryLine.groupBy({
              by: ['purchaseOrderItemId'],
              where: { delivery: { legId: l.id } },
              _sum: { qty: true },
            });
            const lines = items
              .map((it) => {
                const key = PRODUCTS.find(
                  (p) => productId.get(p.key) === it.productId,
                )!.key;
                const before = Number(
                  delivered.find((d) => d.purchaseOrderItemId === it.id)?._sum
                    .qty ?? 0,
                );
                const qty = part.qty
                  ? (part.qty[key] ?? 0)
                  : Number(it.orderedQty) - before;
                return { purchaseOrderItemId: it.id, qty };
              })
              .filter((x) => x.qty > 0);
            await deliveries.recordDelivery(
              l.id,
              {
                arrivedOn: part.day,
                lines,
                note:
                  i === 0
                    ? 'First truck from the airport'
                    : 'The rest, held back at the airport',
              },
              actor,
            );
            did(`${c.code}: delivery in Cairo ${part.day}`);
          },
        );
      }
    }

    for (const [i, day] of c.receivedOn.entries()) {
      at(day, 0, `${c.code} received`, async () => {
        const cid = await cycleId(c);
        const last = await db.shippingLeg.findFirstOrThrow({
          where: { cycleId: cid },
          orderBy: { sequence: 'desc' },
        });
        const all = await db.shipmentDelivery.findMany({
          where: { legId: last.id },
          orderBy: { arrivedOn: 'asc' },
          include: {
            lines: {
              include: { inventoryBatches: { select: { receivedQty: true } } },
            },
          },
        });
        const delivery = all[i];
        if (!delivery)
          throw new Error(`${c.code}: no delivery ${i + 1} to receive`);
        const waiting = delivery.lines.filter(
          (l) =>
            l.inventoryBatches.reduce((s, b) => s + Number(b.receivedQty), 0) <
            Number(l.qty),
        );
        if (waiting.length === 0) return;
        await inventory.verifyStock(
          cid,
          {
            deliveryId: delivery.id,
            receivedOn: day,
            items: waiting.map((l) => ({
              deliveryLineId: l.id,
              receivedQty: Number(l.qty),
            })),
          },
          actor,
        );
        did(`${c.code}: ${waiting.length} lines counted into stock ${day}`);
      });
    }

    if (c.settleOn) {
      const settleOn = c.settleOn;
      at(settleOn, 9, `${c.code} settled`, async () => {
        const cid = await cycleId(c);
        const current = await db.settlement.findFirst({
          where: {
            cycleId: cid,
            status: { in: ['DRAFT', 'APPROVED', 'PAID'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (current?.status === 'PAID') return;
        if (!current) {
          await settlements.calculate(cid, actor);
          did(`${c.code}: settlement calculated`);
        }
        const s = await db.settlement.findFirstOrThrow({
          where: { cycleId: cid, status: { in: ['DRAFT', 'APPROVED'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (s.status === 'DRAFT') {
          await settlements.approve(s.id, actor);
          did(`${c.code}: settlement approved`);
        }
        await settlements.markPaid(s.id, actor, {});
        did(`${c.code}: settlement paid out, cycle closed`);
        // Settlement is always "now"; it happened on settleOn.
        const when = instantOfDay(settleOn);
        await db.settlement.update({
          where: { id: s.id },
          data: { calculatedAt: when, approvedAt: when, paidAt: when },
        });
        await db.importCycle.update({
          where: { id: cid },
          data: { closedOn: when },
        });
      });
    }
  }

  for (const e of plan.expenses) {
    at(e.day, 1, `expense ${e.category} ${e.day}`, async () => {
      const found = await db.financialTransaction.findFirst({
        where: {
          type: 'EXPENSE',
          category: e.category,
          reason: e.note,
          occurredOn: new Date(`${e.day}T00:00:00Z`),
        },
      });
      if (found) return;
      const cycle = e.cycle
        ? CYCLES.find((c) => c.key === e.cycle)!
        : undefined;
      await ledger.create(
        {
          kind: 'EXPENSE',
          category: e.category,
          amount: e.amount,
          currency: 'EGP',
          occurredOn: e.day,
          note: e.note,
          ...(cycle ? { cycleId: await cycleId(cycle) } : {}),
        },
        actor,
      );
      did(
        `expense ${e.day} ${e.category} ${e.amount}${cycle ? ` (${cycle.code})` : ''}`,
      );
    });
  }

  const saleIdOf = new Map<string, string>();
  const saleId = async (key: string) => {
    const known = saleIdOf.get(key);
    if (known) return known;
    const found = await db.saleOrder.findFirst({
      where: { idempotencyKey: key },
    });
    if (!found) throw new Error(`sale ${key} not recorded`);
    saleIdOf.set(key, found.id);
    return found.id;
  };
  const items = (lines: Line[]) =>
    lines.map((l) => ({
      productId: productId.get(l.product)!,
      quantity: l.qty,
      unitPrice: l.price,
      discount: l.discount,
    }));

  for (const [i, s] of plan.sales.entries()) {
    at(s.day, 2, `sale ${s.key}`, async () => {
      let order = await db.saleOrder.findFirst({
        where: { idempotencyKey: s.key },
      });
      if (!order) {
        const by = actorFor(i);
        if (s.shop) {
          await sales.create(
            {
              customerId: shopId.get(s.shop),
              channel: 'B2B',
              currency: 'EGP',
              items: items(s.lines),
              confirm: true,
              orderedOn: s.day,
            },
            by,
            s.key,
          );
        } else {
          await sales.create(
            {
              walkIn: true,
              channel: 'B2C',
              currency: 'EGP',
              items: items(s.lines),
              orderedOn: s.day,
              payment: { method: s.method },
            },
            by,
            s.key,
          );
        }
        order = await db.saleOrder.findFirstOrThrow({
          where: { idempotencyKey: s.key },
        });
        did(
          `sale ${s.day} ${s.shop ? SHOP.get(s.shop)!.name : 'walk-in'} ${order.total.toFixed(2)}${s.kind === 'clearance' ? ' (clearance of the first cycle)' : ''}`,
        );
      }
      saleIdOf.set(s.key, order.id);
      if (s.kind === 'cancelled' && order.status !== 'CANCELLED') {
        await sales.cancelOrder(order.id, actor);
        did(`sale ${order.orderNo} cancelled`);
      }
      if (s.contract) {
        const existing = await db.paymentPlan.findUnique({
          where: { saleOrderId: order.id },
        });
        if (!existing) {
          // Agreed on the sale's day; the service only takes instalments from today on, so the
          // schedule goes in moved forward and is moved back straight after.
          const today = businessToday();
          const first = s.contract.instalments[0].dueOn;
          const shift = first < today ? daysBetween(first, today) + 1 : 0;
          const made = await plans.createForSale(
            order.id,
            {
              note: 'Three monthly instalments',
              instalments: s.contract.instalments.map((x) => ({
                dueOn: addDays(x.dueOn, shift),
                amount: x.amount,
              })),
            },
            actor,
          );
          await db.paymentPlan.update({
            where: { id: made.data.id },
            data: { agreedOn: new Date(`${s.day}T00:00:00Z`) },
          });
          for (const inst of made.data.instalments) {
            await db.paymentPlanInstalment.update({
              where: { id: inst.id },
              data: {
                dueOn: new Date(
                  `${addDays(inst.dueOn.toISOString().slice(0, 10), -shift)}T00:00:00Z`,
                ),
              },
            });
          }
          did(`instalment contract on ${order.orderNo}`);
        }
      }
    });
  }

  for (const r of plan.returns) {
    at(r.day, 4, `return ${r.key}`, async () => {
      const id = await saleId(r.sale);
      const found = await db.saleReturn.findFirst({
        where: { saleOrderId: id, reason: r.reason },
      });
      if (found) return;
      const item = await db.saleItem.findFirstOrThrow({
        where: { saleOrderId: id, productId: productId.get(r.product) },
      });
      await returns.create(
        {
          saleOrderId: id,
          reason: r.reason,
          returnedOn: r.day,
          refundMethod: r.refund,
          items: [{ saleItemId: item.id, qty: r.qty, restock: r.restock }],
        },
        actor,
      );
      did(`return ${r.day}: ${r.qty} × ${r.product} (${r.reason})`);
    });
  }

  for (const p of plan.payments) {
    at(p.day, 3, `payment ${p.key}`, async () => {
      const found = await db.payment.findFirst({ where: { reference: p.key } });
      if (found) return;
      const id = await saleId(p.sale);
      const order = await db.saleOrder.findUniqueOrThrow({ where: { id } });
      const owed = Number(order.outstanding);
      const amount = p.amount === 'rest' ? owed : Math.min(p.amount, owed);
      if (amount <= 0) return;
      await payments.create(
        {
          customerId: order.customerId,
          amount: Math.round(amount * 100) / 100,
          currency: 'EGP',
          receivedOn: p.day,
          method: p.method,
          reference: p.key,
          orderId: id,
        },
        actor,
        p.key,
      );
      did(`payment ${p.day} ${amount.toFixed(2)} on ${order.orderNo}`);
    });
  }

  const sampleSteps = async (s: SamplesPlan) => {
    const found = await db.saleOrder.findFirst({
      where: { idempotencyKey: s.key },
    });
    if (found) return found;
    await sales.create(
      {
        samples: true,
        customerId: shopId.get(s.shop),
        channel: 'B2B',
        currency: 'EGP',
        items: items(s.lines),
        orderedOn: s.day,
      },
      actor,
      s.key,
    );
    did(`samples left at ${SHOP.get(s.shop)!.name} ${s.day}`);
    return db.saleOrder.findFirstOrThrow({ where: { idempotencyKey: s.key } });
  };
  const { open, bought, writtenOff } = plan.samples;
  at(
    writtenOff.day,
    2,
    'samples left (written off later)',
    async () => void (await sampleSteps(writtenOff)),
  );
  at(writtenOff.writeOffOn, 2, 'samples written off', async () => {
    const o = await sampleSteps(writtenOff);
    if (o.status !== 'SAMPLES') return;
    await sales.writeOffSamples(
      o.id,
      { reason: 'The shop kept the demo headsets for its display' },
      actor,
    );
    did(`samples at ${SHOP.get(writtenOff.shop)!.name} written off`);
  });
  at(
    bought.day,
    2,
    'samples left (bought later)',
    async () => void (await sampleSteps(bought)),
  );
  at(bought.convertOn, 2, 'samples bought', async () => {
    const o = await sampleSteps(bought);
    if (o.status !== 'SAMPLES') return;
    await sales.convertSamples(
      o.id,
      { orderedOn: bought.convertOn, items: items(bought.keep) },
      actor,
    );
    did(`samples at ${SHOP.get(bought.shop)!.name} bought`);
  });
  at(
    open.day,
    2,
    'samples left (still out)',
    async () => void (await sampleSteps(open)),
  );

  steps.sort((a, b) => a.day.localeCompare(b.day) || a.rank - b.rank);
  for (const step of steps) {
    // A second of slack for the clock; anything older was already moved to its own day.
    const since = new Date(Date.now() - 1000);
    try {
      await step.run();
    } catch (err) {
      console.error(`\n✗ ${step.day} ${step.label}`);
      throw err;
    }
    await backdate(since, step.day);
  }

  console.log(
    written.created === 0
      ? 'Nothing to add: the history is already there.'
      : `Done: ${written.created} records added.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
