/**
 * The words of the instalment contract (BUSINESS_LOGIC §7, 2026-10-16), in
 * both languages at once.
 *
 * Not in the locale files, because the contract's language is not the app's:
 * it prints in Arabic by default whatever language the office is reading in,
 * and the switch on the page turns the document — not the app — to English.
 *
 * The five terms are fixed text, the suggested wording the owner approved in
 * the mock. He may change it later; it lives here, once.
 */

export type ContractLanguage = 'ar' | 'en';

export interface ContractText {
  title: string;
  tagline: string;
  number: string;
  date: string;
  city: string;
  parties: string;
  seller: string;
  sellerName: string;
  representative: string;
  phone: string;
  buyer: string;
  address: string;
  idOrRegistration: string;
  goods: string;
  line: string;
  item: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  totalPrice: string;
  paidAtSigning: string;
  remaining: string;
  schedule: string;
  dueOn: string;
  instalment: string;
  receipt: string;
  terms: string;
  clauses: readonly string[];
  sellerSigns: string;
  buyerSigns: string;
  nameAndSignature: string;
  copies: string;
  page: string;
}

export const CONTRACT_TEXT: Record<ContractLanguage, ContractText> = {
  ar: {
    title: 'عقد بيع بالتقسيط',
    tagline: 'S&F — قطع غيار وإكسسوارات الموتوسيكلات',
    number: 'رقم العقد',
    date: 'التاريخ',
    city: 'القاهرة',
    parties: 'الطرفان',
    seller: 'الطرف الأول (البائع)',
    sellerName: 'S&F',
    representative: 'يمثله',
    phone: 'الهاتف',
    buyer: 'الطرف الثاني (المشتري)',
    address: 'العنوان',
    idOrRegistration: 'رقم البطاقة / السجل التجاري',
    goods: 'البضاعة المبيعة',
    line: '#',
    item: 'الصنف',
    quantity: 'الكمية',
    unitPrice: 'سعر القطعة',
    lineTotal: 'الإجمالي',
    totalPrice: 'إجمالي الثمن',
    paidAtSigning: 'المدفوع عند التوقيع',
    remaining: 'المتبقي بالتقسيط',
    schedule: 'جدول الأقساط',
    dueOn: 'تاريخ الاستحقاق',
    instalment: 'قيمة القسط',
    receipt: 'توقيع الاستلام',
    terms: 'الشروط',
    clauses: [
      'يقر الطرف الثاني باستلام البضاعة الموضحة أعلاه بحالة سليمة ومطابقة للمواصفات.',
      'يلتزم الطرف الثاني بسداد الأقساط في مواعيدها الموضحة بجدول الأقساط نقدًا أو بتحويل بنكي.',
      'تظل ملكية البضاعة للطرف الأول حتى سداد كامل الثمن.',
      'في حالة التأخر عن سداد قسطين متتاليين يحق للطرف الأول المطالبة بباقي الثمن دفعة واحدة.',
      'تختص محاكم القاهرة بنظر أي نزاع ينشأ عن هذا العقد.',
    ],
    sellerSigns: 'الطرف الأول (البائع)',
    buyerSigns: 'الطرف الثاني (المشتري)',
    nameAndSignature: 'الاسم والتوقيع',
    copies: 'حُرر هذا العقد من نسختين بيد كل طرف نسخة للعمل بموجبها.',
    page: 'صفحة 1 من 1',
  },
  en: {
    title: 'Instalment Sale Contract',
    tagline: 'S&F — Motorcycle parts and accessories',
    number: 'Contract no.',
    date: 'Date',
    city: 'Cairo',
    parties: 'The parties',
    seller: 'First party (seller)',
    sellerName: 'S&F',
    representative: 'Represented by',
    phone: 'Phone',
    buyer: 'Second party (buyer)',
    address: 'Address',
    idOrRegistration: 'National ID / commercial registration no.',
    goods: 'Goods sold',
    line: '#',
    item: 'Item',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    lineTotal: 'Total',
    totalPrice: 'Total price',
    paidAtSigning: 'Paid at signing',
    remaining: 'Remaining in instalments',
    schedule: 'Instalment schedule',
    dueOn: 'Due date',
    instalment: 'Instalment',
    receipt: 'Receipt signature',
    terms: 'Terms',
    clauses: [
      'The second party acknowledges receiving the goods listed above in sound condition and as specified.',
      'The second party undertakes to pay the instalments on the dates set out in the instalment schedule, in cash or by bank transfer.',
      'Ownership of the goods remains with the first party until the full price has been paid.',
      'If two consecutive instalments are not paid on time, the first party may demand the rest of the price in a single payment.',
      'The courts of Cairo have jurisdiction over any dispute arising from this contract.',
    ],
    sellerSigns: 'First party (seller)',
    buyerSigns: 'Second party (buyer)',
    nameAndSignature: 'Name and signature',
    copies: 'This contract is made in two copies, one held by each party to act upon.',
    page: 'Page 1 of 1',
  },
};

/** A calendar day as the contract prints it: DD/MM/YYYY, Latin digits, in both languages. */
export function contractDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
