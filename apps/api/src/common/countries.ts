import { badRequest } from './api-error';
import { arabicSearchKey } from './arabic-names';

/**
 * A supplier's country (BUSINESS_LOGIC §21, 2026-10-16).
 *
 * Stored as an ISO 3166-1 alpha-2 code — `CN`, `AE`, `EG` — never as the words
 * someone typed. It used to be free text, so one supplier said "China", the
 * next "CN" and a third "الصين", and a list grouped or searched by country
 * could not tell they were the same place. The screen shows the name in the
 * reader's language (`Intl.DisplayNames`); the record holds the code.
 *
 * This is the one list. The office app keeps a copy of the codes
 * (`apps/web/src/lib/countries.ts`) pinned to this file by a unit test, and the
 * migration that converted the free text (`20261016100000_supplier_country_codes`)
 * maps exactly `countryMigrationMap()` — a test reads the SQL and compares.
 *
 * Each entry: the code, and its English short name as the assistant reports it
 * and as the migration matched it.
 */
export const COUNTRIES = [
  ['AD', 'Andorra'],
  ['AE', 'United Arab Emirates'],
  ['AF', 'Afghanistan'],
  ['AG', 'Antigua and Barbuda'],
  ['AI', 'Anguilla'],
  ['AL', 'Albania'],
  ['AM', 'Armenia'],
  ['AO', 'Angola'],
  ['AQ', 'Antarctica'],
  ['AR', 'Argentina'],
  ['AS', 'American Samoa'],
  ['AT', 'Austria'],
  ['AU', 'Australia'],
  ['AW', 'Aruba'],
  ['AX', 'Aland Islands'],
  ['AZ', 'Azerbaijan'],
  ['BA', 'Bosnia and Herzegovina'],
  ['BB', 'Barbados'],
  ['BD', 'Bangladesh'],
  ['BE', 'Belgium'],
  ['BF', 'Burkina Faso'],
  ['BG', 'Bulgaria'],
  ['BH', 'Bahrain'],
  ['BI', 'Burundi'],
  ['BJ', 'Benin'],
  ['BL', 'Saint Barthelemy'],
  ['BM', 'Bermuda'],
  ['BN', 'Brunei'],
  ['BO', 'Bolivia'],
  ['BQ', 'Caribbean Netherlands'],
  ['BR', 'Brazil'],
  ['BS', 'Bahamas'],
  ['BT', 'Bhutan'],
  ['BV', 'Bouvet Island'],
  ['BW', 'Botswana'],
  ['BY', 'Belarus'],
  ['BZ', 'Belize'],
  ['CA', 'Canada'],
  ['CC', 'Cocos (Keeling) Islands'],
  ['CD', 'Democratic Republic of the Congo'],
  ['CF', 'Central African Republic'],
  ['CG', 'Republic of the Congo'],
  ['CH', 'Switzerland'],
  ['CI', "Cote d'Ivoire"],
  ['CK', 'Cook Islands'],
  ['CL', 'Chile'],
  ['CM', 'Cameroon'],
  ['CN', 'China'],
  ['CO', 'Colombia'],
  ['CR', 'Costa Rica'],
  ['CU', 'Cuba'],
  ['CV', 'Cape Verde'],
  ['CW', 'Curacao'],
  ['CX', 'Christmas Island'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DE', 'Germany'],
  ['DJ', 'Djibouti'],
  ['DK', 'Denmark'],
  ['DM', 'Dominica'],
  ['DO', 'Dominican Republic'],
  ['DZ', 'Algeria'],
  ['EC', 'Ecuador'],
  ['EE', 'Estonia'],
  ['EG', 'Egypt'],
  ['EH', 'Western Sahara'],
  ['ER', 'Eritrea'],
  ['ES', 'Spain'],
  ['ET', 'Ethiopia'],
  ['FI', 'Finland'],
  ['FJ', 'Fiji'],
  ['FK', 'Falkland Islands'],
  ['FM', 'Micronesia'],
  ['FO', 'Faroe Islands'],
  ['FR', 'France'],
  ['GA', 'Gabon'],
  ['GB', 'United Kingdom'],
  ['GD', 'Grenada'],
  ['GE', 'Georgia'],
  ['GF', 'French Guiana'],
  ['GG', 'Guernsey'],
  ['GH', 'Ghana'],
  ['GI', 'Gibraltar'],
  ['GL', 'Greenland'],
  ['GM', 'Gambia'],
  ['GN', 'Guinea'],
  ['GP', 'Guadeloupe'],
  ['GQ', 'Equatorial Guinea'],
  ['GR', 'Greece'],
  ['GS', 'South Georgia and the South Sandwich Islands'],
  ['GT', 'Guatemala'],
  ['GU', 'Guam'],
  ['GW', 'Guinea-Bissau'],
  ['GY', 'Guyana'],
  ['HK', 'Hong Kong'],
  ['HM', 'Heard Island and McDonald Islands'],
  ['HN', 'Honduras'],
  ['HR', 'Croatia'],
  ['HT', 'Haiti'],
  ['HU', 'Hungary'],
  ['ID', 'Indonesia'],
  ['IE', 'Ireland'],
  ['IL', 'Israel'],
  ['IM', 'Isle of Man'],
  ['IN', 'India'],
  ['IO', 'British Indian Ocean Territory'],
  ['IQ', 'Iraq'],
  ['IR', 'Iran'],
  ['IS', 'Iceland'],
  ['IT', 'Italy'],
  ['JE', 'Jersey'],
  ['JM', 'Jamaica'],
  ['JO', 'Jordan'],
  ['JP', 'Japan'],
  ['KE', 'Kenya'],
  ['KG', 'Kyrgyzstan'],
  ['KH', 'Cambodia'],
  ['KI', 'Kiribati'],
  ['KM', 'Comoros'],
  ['KN', 'Saint Kitts and Nevis'],
  ['KP', 'North Korea'],
  ['KR', 'South Korea'],
  ['KW', 'Kuwait'],
  ['KY', 'Cayman Islands'],
  ['KZ', 'Kazakhstan'],
  ['LA', 'Laos'],
  ['LB', 'Lebanon'],
  ['LC', 'Saint Lucia'],
  ['LI', 'Liechtenstein'],
  ['LK', 'Sri Lanka'],
  ['LR', 'Liberia'],
  ['LS', 'Lesotho'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['LV', 'Latvia'],
  ['LY', 'Libya'],
  ['MA', 'Morocco'],
  ['MC', 'Monaco'],
  ['MD', 'Moldova'],
  ['ME', 'Montenegro'],
  ['MF', 'Saint Martin'],
  ['MG', 'Madagascar'],
  ['MH', 'Marshall Islands'],
  ['MK', 'North Macedonia'],
  ['ML', 'Mali'],
  ['MM', 'Myanmar'],
  ['MN', 'Mongolia'],
  ['MO', 'Macao'],
  ['MP', 'Northern Mariana Islands'],
  ['MQ', 'Martinique'],
  ['MR', 'Mauritania'],
  ['MS', 'Montserrat'],
  ['MT', 'Malta'],
  ['MU', 'Mauritius'],
  ['MV', 'Maldives'],
  ['MW', 'Malawi'],
  ['MX', 'Mexico'],
  ['MY', 'Malaysia'],
  ['MZ', 'Mozambique'],
  ['NA', 'Namibia'],
  ['NC', 'New Caledonia'],
  ['NE', 'Niger'],
  ['NF', 'Norfolk Island'],
  ['NG', 'Nigeria'],
  ['NI', 'Nicaragua'],
  ['NL', 'Netherlands'],
  ['NO', 'Norway'],
  ['NP', 'Nepal'],
  ['NR', 'Nauru'],
  ['NU', 'Niue'],
  ['NZ', 'New Zealand'],
  ['OM', 'Oman'],
  ['PA', 'Panama'],
  ['PE', 'Peru'],
  ['PF', 'French Polynesia'],
  ['PG', 'Papua New Guinea'],
  ['PH', 'Philippines'],
  ['PK', 'Pakistan'],
  ['PL', 'Poland'],
  ['PM', 'Saint Pierre and Miquelon'],
  ['PN', 'Pitcairn Islands'],
  ['PR', 'Puerto Rico'],
  ['PS', 'Palestine'],
  ['PT', 'Portugal'],
  ['PW', 'Palau'],
  ['PY', 'Paraguay'],
  ['QA', 'Qatar'],
  ['RE', 'Reunion'],
  ['RO', 'Romania'],
  ['RS', 'Serbia'],
  ['RU', 'Russia'],
  ['RW', 'Rwanda'],
  ['SA', 'Saudi Arabia'],
  ['SB', 'Solomon Islands'],
  ['SC', 'Seychelles'],
  ['SD', 'Sudan'],
  ['SE', 'Sweden'],
  ['SG', 'Singapore'],
  ['SH', 'Saint Helena'],
  ['SI', 'Slovenia'],
  ['SJ', 'Svalbard and Jan Mayen'],
  ['SK', 'Slovakia'],
  ['SL', 'Sierra Leone'],
  ['SM', 'San Marino'],
  ['SN', 'Senegal'],
  ['SO', 'Somalia'],
  ['SR', 'Suriname'],
  ['SS', 'South Sudan'],
  ['ST', 'Sao Tome and Principe'],
  ['SV', 'El Salvador'],
  ['SX', 'Sint Maarten'],
  ['SY', 'Syria'],
  ['SZ', 'Eswatini'],
  ['TC', 'Turks and Caicos Islands'],
  ['TD', 'Chad'],
  ['TF', 'French Southern Territories'],
  ['TG', 'Togo'],
  ['TH', 'Thailand'],
  ['TJ', 'Tajikistan'],
  ['TK', 'Tokelau'],
  ['TL', 'Timor-Leste'],
  ['TM', 'Turkmenistan'],
  ['TN', 'Tunisia'],
  ['TO', 'Tonga'],
  ['TR', 'Turkey'],
  ['TT', 'Trinidad and Tobago'],
  ['TV', 'Tuvalu'],
  ['TW', 'Taiwan'],
  ['TZ', 'Tanzania'],
  ['UA', 'Ukraine'],
  ['UG', 'Uganda'],
  ['UM', 'United States Minor Outlying Islands'],
  ['US', 'United States'],
  ['UY', 'Uruguay'],
  ['UZ', 'Uzbekistan'],
  ['VA', 'Vatican City'],
  ['VC', 'Saint Vincent and the Grenadines'],
  ['VE', 'Venezuela'],
  ['VG', 'British Virgin Islands'],
  ['VI', 'U.S. Virgin Islands'],
  ['VN', 'Vietnam'],
  ['VU', 'Vanuatu'],
  ['WF', 'Wallis and Futuna'],
  ['WS', 'Samoa'],
  ['YE', 'Yemen'],
  ['YT', 'Mayotte'],
  ['ZA', 'South Africa'],
  ['ZM', 'Zambia'],
  ['ZW', 'Zimbabwe'],
] as const satisfies readonly (readonly [string, string])[];

export type CountryCode = (typeof COUNTRIES)[number][0];

/** Every code, A–Z. */
export const COUNTRY_CODES: readonly CountryCode[] = COUNTRIES.map(([c]) => c);

/**
 * The countries the business buys from, offered first in the picker: China and
 * the Emirates are where the goods come from, Egypt is home, Turkey and India
 * are the next most likely. GUESS (§21) — the rest follow A–Z.
 */
export const PREFERRED_COUNTRIES: readonly CountryCode[] = [
  'CN',
  'AE',
  'EG',
  'TR',
  'IN',
];

const ENGLISH = new Map<string, string>(COUNTRIES);

/**
 * Other ways people write a country, beyond its code and English name — used
 * to convert the old free text and to read what a partner tells the assistant.
 * Arabic names for the countries the business deals with; Arabic for the rest
 * comes from `Intl.DisplayNames` when the assistant resolves one.
 */
const ALIASES: Partial<Record<CountryCode, readonly string[]>> = {
  CN: ['chn', 'prc', "people's republic of china", 'mainland china', 'الصين'],
  AE: [
    'are',
    'uae',
    'u.a.e.',
    'emirates',
    'the emirates',
    'dubai',
    'abu dhabi',
    'sharjah',
    'الإمارات',
    'الإمارات العربية المتحدة',
    'دبي',
  ],
  EG: ['egy', 'misr', 'مصر', 'جمهورية مصر العربية'],
  TR: ['tur', 'turkiye', 'türkiye', 'تركيا'],
  IN: ['ind', 'الهند'],
  HK: ['hkg', 'هونغ كونغ', 'هونج كونج'],
  TW: ['twn', 'تايوان'],
  JP: ['jpn', 'اليابان'],
  KR: ['kor', 'korea', 'republic of korea', 'كوريا', 'كوريا الجنوبية'],
  SA: ['sau', 'ksa', 'saudi', 'السعودية', 'المملكة العربية السعودية'],
  DE: ['deu', 'ألمانيا'],
  US: [
    'usa',
    'u.s.',
    'u.s.a.',
    'united states of america',
    'america',
    'الولايات المتحدة',
    'أمريكا',
  ],
  GB: [
    'uk',
    'u.k.',
    'great britain',
    'britain',
    'england',
    'المملكة المتحدة',
    'بريطانيا',
  ],
  TH: ['tha', 'تايلاند'],
  VN: ['viet nam', 'فيتنام'],
  MY: ['ماليزيا'],
  ID: ['إندونيسيا'],
  IT: ['إيطاليا'],
  SG: ['سنغافورة'],
  OM: ['عمان', 'سلطنة عمان'],
  KW: ['الكويت'],
  QA: ['قطر'],
  BH: ['البحرين'],
  JO: ['الأردن'],
  CZ: ['czech republic'],
  CI: ['ivory coast'],
  CV: ['cabo verde'],
  CD: ['dr congo', 'drc', 'congo kinshasa'],
  CG: ['congo', 'congo brazzaville'],
  MM: ['burma'],
  MK: ['macedonia'],
  SZ: ['swaziland'],
  RU: ['russian federation'],
  IR: ['islamic republic of iran'],
  SY: ['syrian arab republic'],
  LA: ["lao people's democratic republic"],
  MD: ['republic of moldova'],
  TZ: ['united republic of tanzania'],
  VA: ['holy see'],
  BN: ['brunei darussalam'],
  MO: ['macau'],
  FM: ['federated states of micronesia'],
};

/**
 * How a typed country is compared: Arabic spelling forgiven the way product
 * search forgives it (أ/إ/ا, ة/ه, ى/ي — `arabicSearchKey`), lower-case, and
 * punctuation read as a space, so "U.A.E." and "uae" and "Cote d'Ivoire" and
 * "cote d ivoire" meet. The migration does the same in SQL, with the database's
 * own `arabic_search_key()`.
 */
export function countryKey(typed: string | null | undefined): string {
  return arabicSearchKey(typed)
    .replace(/[.,'’()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every spelling the old free text is converted from, and nothing else: each
 * code (lower-case after `countryKey`), each English name, each alias. Built
 * from the lists above only — never from `Intl`, whose names change between
 * Node releases ("Turkey" became "Türkiye") — so the migration's SQL can be
 * checked against it word for word.
 */
export function countryMigrationMap(): Map<string, CountryCode> {
  const map = new Map<string, CountryCode>();
  const add = (spelling: string, code: CountryCode) => {
    const key = countryKey(spelling);
    const had = map.get(key);
    if (had && had !== code) {
      throw new Error(`"${spelling}" spells both ${had} and ${code}`);
    }
    map.set(key, code);
  };
  for (const [code, name] of COUNTRIES) {
    add(code, code);
    add(name, code);
  }
  for (const [code, spellings] of Object.entries(ALIASES)) {
    for (const s of spellings ?? []) add(s, code as CountryCode);
  }
  return map;
}

const KNOWN = new Set<string>(COUNTRY_CODES);

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && KNOWN.has(value);
}

/** "China" for CN; a value that is not a code is returned as it is. */
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  return ENGLISH.get(code) ?? code;
}

/**
 * The code a supplier is saved with — what the office form and the API send.
 *
 * A code only, upper- or lower-case: `cn` is read as `CN`. A name is not taken
 * here — the form offers codes, and a name typed straight at the API would be a
 * second, unchecked way in. The assistant turns a name into a code first
 * (`resolveCountry`). Empty is refused: every supplier is somewhere.
 */
export function assertCountryCode(value: unknown): CountryCode {
  const typed = typeof value === 'string' ? value.trim() : '';
  if (!typed) {
    throw badRequest('COUNTRY_REQUIRED', "Choose the supplier's country.");
  }
  const code = typed.toUpperCase();
  if (!isCountryCode(code)) {
    throw badRequest(
      'COUNTRY_UNKNOWN',
      `"${typed}" is not a country code. Send the two-letter ISO 3166-1 code, such as CN, AE or EG.`,
      { country: typed },
    );
  }
  return code;
}

/** The names `Intl` knows a code by in English and Arabic, for the assistant. */
function intlSpellings(): Map<string, Set<CountryCode>> {
  const out = new Map<string, Set<CountryCode>>();
  for (const locale of ['en', 'ar']) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames(locale, { type: 'region' });
    } catch {
      continue;
    }
    for (const code of COUNTRY_CODES) {
      const name = names.of(code);
      if (!name || name === code) continue;
      const key = countryKey(name);
      out.set(key, (out.get(key) ?? new Set()).add(code));
    }
  }
  return out;
}

let lookup: {
  exact: Map<string, CountryCode>;
  ambiguous: Map<string, CountryCode[]>;
} | null = null;

function spellings() {
  if (lookup) return lookup;
  const exact = countryMigrationMap();
  const ambiguous = new Map<string, CountryCode[]>();
  for (const [key, codes] of intlSpellings()) {
    if (exact.has(key)) continue; // our own list decides first
    if (codes.size === 1) exact.set(key, [...codes][0]);
    else ambiguous.set(key, [...codes]);
  }
  lookup = { exact, ambiguous };
  return lookup;
}

const label = (code: CountryCode) => `${countryName(code)} (${code})`;

/**
 * Every country a search finds by part of a name, in English or Arabic, or by
 * its code — for a list's search box (server-side lists, owner 2026-10-25):
 * "صين" finds CN, as the office's own copy of this search did in the browser.
 */
export function countriesContaining(
  typed: string | null | undefined,
): CountryCode[] {
  const term = countryKey(typed);
  if (!term) return [];
  const found = new Set<CountryCode>();
  const { exact, ambiguous } = spellings();
  for (const [key, code] of exact) if (key.includes(term)) found.add(code);
  for (const [key, codes] of ambiguous)
    if (key.includes(term)) codes.forEach((c) => found.add(c));
  return [...found];
}

/**
 * The code a typed country spells, or null — `resolveCountry` without the
 * refusal, for a search box: "China" also finds the suppliers saved as CN.
 */
export function findCountry(
  typed: string | null | undefined,
): CountryCode | null {
  const text = (typed ?? '').trim();
  if (!text) return null;
  if (isCountryCode(text.toUpperCase()))
    return text.toUpperCase() as CountryCode;
  return spellings().exact.get(countryKey(text)) ?? null;
}

/**
 * A country as a partner says it — "China", "الصين", "cn", "U.A.E." — read to
 * its code, for the assistant.
 *
 * Exact after `countryKey`, never a guess from a fragment: "Chin" is not China.
 * When a fragment or a shared name does point somewhere, the refusal names the
 * candidates so the assistant can ask which one was meant.
 */
export function resolveCountry(typed: unknown): CountryCode {
  const text = typeof typed === 'string' ? typed.trim() : '';
  if (!text) {
    throw badRequest('COUNTRY_REQUIRED', "Choose the supplier's country.");
  }
  const found = findCountry(text);
  if (found) return found;

  const key = countryKey(text);
  const { exact, ambiguous } = spellings();

  let candidates = ambiguous.get(key) ?? [];
  if (candidates.length === 0 && key.length >= 3) {
    const near = new Set<CountryCode>();
    for (const [k, code] of exact) {
      if (k.length > 2 && (k.includes(key) || key.includes(k))) near.add(code);
    }
    candidates = [...near].slice(0, 5);
  }
  const hint = candidates.length
    ? ` Did you mean ${candidates.map(label).join(', ')}?`
    : '';
  throw badRequest(
    'COUNTRY_UNKNOWN',
    `"${text}" is not a country this system knows.${hint} Give the country's English name or its two-letter ISO code, such as CN, AE or EG.`,
    { country: text },
  );
}
