/**
 * What a notification says, by code — for the two places the server itself
 * has to put it into words.
 *
 * A notification row stores a `code` and its `params`; the reader's app turns
 * those into a sentence in the reader's language (`notifications.<code>` in the
 * web's locale files), the same bargain `api-error.ts` makes for refusals
 * (CLAUDE.md rule 9). The server still needs words twice:
 *
 * - the English `title` kept on the row, which the logs record and a client
 *   that has never heard of a code falls back to;
 * - a **push**, which the server sends while nobody's app is open to translate
 *   it. See `pushLocaleFor` for which language that is.
 *
 * Pure: no Nest, no Prisma — the web's tests import it to check that every code
 * here has a translation there, and none there has outlived its code.
 */

export type NotificationLocale = 'en' | 'ar';

interface Words {
  /** One line: the bell, the list, the push title. */
  title: string;
  /** The push's second line, for the events that are pushed. */
  body?: string;
}

export const NOTIFICATION_MESSAGES = {
  // ── Cycles ────────────────────────────────────────────────────────────
  ADDED_TO_CYCLE: {
    en: { title: 'You have been added to cycle {cycleCode}' },
    ar: { title: 'تمت إضافتك إلى الدورة {cycleCode}' },
  },
  CYCLE_CREATED: {
    en: { title: 'New import cycle {cycleCode} created' },
    ar: { title: 'تم إنشاء دورة استيراد جديدة {cycleCode}' },
  },
  CYCLE_STATUS_CHANGED: {
    en: { title: 'Cycle {cycleCode} moved to {toStatus}' },
    ar: { title: 'انتقلت الدورة {cycleCode} إلى {toStatus}' },
  },
  PURCHASE_ORDER_CREATED: {
    en: {
      title: 'New purchase order {reference} created for cycle {cycleCode}',
    },
    ar: { title: 'طلب شراء جديد {reference} للدورة {cycleCode}' },
  },
  SHIPPING_LEG_ARRIVED: {
    en: {
      title: 'Shipping leg {sequence} ({origin} → {destination}) has arrived',
    },
    ar: { title: 'وصلت مرحلة الشحن {sequence} ({origin} ← {destination})' },
  },

  // ── Stock and money ───────────────────────────────────────────────────
  LOW_STOCK_DETECTED: {
    en: { title: 'Low stock detected: {products}' },
    ar: { title: 'مخزون منخفض: {products}' },
  },
  PAYMENT_OVERDUE: {
    en: { title: '{customer} is {amount} EGP behind on {reference}' },
    ar: { title: '{customer} متأخر بمبلغ {amount} جنيه في {reference}' },
  },
  // Per instalment, from the daily job (BUSINESS_LOGIC §7, 2026-10-11).
  // PAYMENT_OVERDUE above stays for the rows written before it.
  INSTALMENT_OVERDUE: {
    en: {
      title:
        '{customer} missed the instalment due {dueOn} on {reference} — {amount} EGP outstanding',
    },
    ar: {
      title:
        '{customer} لم يسدد قسط {dueOn} في {reference} — المتبقي {amount} جنيه',
    },
  },

  // A friend's repayment plan falling behind (§18), from the same daily job.
  LENDER_INSTALMENT_OVERDUE: {
    en: {
      title:
        'Repayment to {lender} due {dueOn} on {reference} is late — {amount} {currency} outstanding',
    },
    ar: {
      title:
        'تأخر سداد {lender} المستحق {dueOn} على {reference} — المتبقي {amount} {currency}',
    },
  },

  // ── What the office hears from the storefront ─────────────────────────
  ORDER_REQUEST_SUBMITTED: {
    en: {
      title: '{shopName} asked to buy — {requestNo}',
      body: 'Stock is held for 48 hours while you answer.',
    },
    ar: {
      title: '{shopName} طلب شراء — {requestNo}',
      body: 'البضاعة محجوزة 48 ساعة حتى ترد.',
    },
  },
  IMPORT_REQUEST_SUBMITTED: {
    en: {
      title: '{shopName} asked for {productName}',
      body: 'A shop wants something we do not stock.',
    },
    ar: {
      title: '{shopName} طلب {productName}',
      body: 'محل يطلب صنفاً غير متوفر لدينا.',
    },
  },
  SHOP_SIGNED_UP: {
    en: {
      title: '{shopName} signed up',
      body: 'They can browse, but cannot order until you verify them.',
    },
    ar: {
      title: 'سجّل {shopName} في المتجر',
      body: 'يمكنه التصفح، ولا يمكنه الطلب حتى توثّقه.',
    },
  },
  HOLD_EXPIRING: {
    en: {
      title: '{requestNo} is still waiting',
      body: 'The stock held for {shopName} goes back on the shelf in six hours.',
    },
    ar: {
      title: 'الطلب {requestNo} ما زال بانتظار الرد',
      body: 'تعود البضاعة المحجوزة لـ {shopName} إلى المخزون خلال ست ساعات.',
    },
  },

  // ── What a shop hears ─────────────────────────────────────────────────
  ORDER_REQUEST_APPROVED: {
    en: { title: '{requestNo} approved', body: 'Your order is confirmed.' },
    ar: { title: 'تمت الموافقة على {requestNo}', body: 'تم تأكيد طلبك.' },
  },
  ORDER_REQUEST_APPROVED_PARTIAL: {
    en: {
      title: '{requestNo} approved',
      body: 'Some of what you asked for is on its way — open it to see what changed.',
    },
    ar: {
      title: 'تمت الموافقة على {requestNo}',
      body: 'جزء مما طلبته في الطريق إليك — افتح الطلب لترى ما تغيّر.',
    },
  },
  ORDER_REQUEST_DECLINED: {
    en: {
      title: '{requestNo} could not be filled',
      body: 'Open it to see why.',
    },
    ar: {
      title: 'تعذّر تنفيذ الطلب {requestNo}',
      body: 'افتح الطلب لمعرفة السبب.',
    },
  },
  IMPORT_REQUEST_SOURCING: {
    en: { title: 'About {productName}', body: 'We are looking for it.' },
    ar: { title: 'بخصوص {productName}', body: 'نبحث عنه الآن.' },
  },
  IMPORT_REQUEST_ANSWERED: {
    en: { title: 'About {productName}', body: 'We have an answer for you.' },
    ar: { title: 'بخصوص {productName}', body: 'لدينا رد على طلبك.' },
  },
  IMPORT_REQUEST_DECLINED: {
    en: { title: 'About {productName}', body: 'We could not source it.' },
    ar: { title: 'بخصوص {productName}', body: 'لم نتمكن من توفيره.' },
  },
} as const satisfies Record<string, Record<NotificationLocale, Words>>;

export type NotificationCode = keyof typeof NOTIFICATION_MESSAGES;

export type NotificationParams = Record<string, string | number>;

export function isNotificationCode(code: string): code is NotificationCode {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_MESSAGES, code);
}

/**
 * The words for a code, in one language, with its params filled in.
 *
 * A param the text names but the caller did not pass is left as `{name}` —
 * visible in a test and in a log, rather than silently becoming "undefined".
 */
export function renderNotification(
  code: NotificationCode,
  params: NotificationParams,
  locale: NotificationLocale,
): { title: string; body?: string } {
  const words: Words = NOTIFICATION_MESSAGES[code][locale];
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params[name] === undefined || params[name] === null
        ? whole
        : String(params[name]),
    );
  return {
    title: fill(words.title),
    ...(words.body ? { body: fill(words.body) } : {}),
  };
}

/**
 * Which language a push goes out in.
 *
 * A push is written by the server while the reader's app is closed, so the
 * server has to choose. Decided 2026-10-10 (U5, docs/build-log/waves/
 * arrivals-and-ux/U5.md):
 *
 * 1. The reader's stored locale, when there is one. Nothing stores one yet —
 *    the parameter is here so storing it later is a one-line change.
 * 2. Otherwise the default of the app that person reads: a shop reads the
 *    storefront, which opens in Arabic for everyone (BUSINESS_LOGIC §13); the
 *    office reads the internal system, whose default is English.
 */
export function pushLocaleFor(reader: {
  role?: string | null;
  locale?: string | null;
}): NotificationLocale {
  if (reader.locale === 'ar' || reader.locale === 'en') return reader.locale;
  return reader.role === 'SHOP_OWNER_PORTAL' ? 'ar' : 'en';
}
