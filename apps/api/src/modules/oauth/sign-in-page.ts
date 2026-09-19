import { escapeHtml } from './oauth.pure';

/**
 * The page a partner sees when connecting Claude.
 *
 * Served by the API, not the office app: the redirect back to Claude has to
 * come from the server that checked the password, and a page with no script
 * has nothing to go wrong in between. Written here in both languages because
 * there is no client to translate it — the API renders the words itself, in
 * the language named by `lang`, which the page's own switch sets.
 *
 * It says what Claude will be able to do before it asks for a password
 * (spec, Screens).
 */

export type PageLang = 'en' | 'ar';

export type PageError =
  | 'wrong_credentials'
  | 'partners_only'
  | 'inactive'
  | 'unknown_client'
  | 'unregistered_redirect';

const TEXT = {
  en: {
    title: 'Connect Claude to MotoParts',
    lead: 'Claude is asking to use MotoParts on your behalf.',
    canHeading: 'Claude will be able to',
    can: [
      'Read cycles, purchase orders, stock, sales, payments, balances and exchange rates.',
      'Record supplier receipts as purchase orders, and run a cycle’s intake: suppliers, products, cycles, shipping legs and verifying stock in.',
    ],
    cannotHeading: 'Claude will not be able to',
    cannot: [
      'Record or change sales, payments, instalments, settlements, returns or the ledger.',
    ],
    confirm:
      'Nothing is changed without a preview you confirm. Everything is recorded under your name. You can disconnect Claude from Settings at any time.',
    email: 'Email',
    password: 'Password',
    submit: 'Sign in and connect',
    switchTo: 'العربية',
    errorTitle: 'This connection cannot continue',
    errors: {
      wrong_credentials: 'The email or password is incorrect.',
      partners_only: 'Only core partners can connect Claude.',
      inactive: 'This account is not active.',
      unknown_client:
        'This Claude connection is not recognised. Start connecting again from Claude.',
      unregistered_redirect:
        'This request did not come from the Claude connection it names. Start connecting again from Claude.',
    } satisfies Record<PageError, string>,
  },
  ar: {
    title: 'ربط Claude بـ MotoParts',
    lead: 'يطلب Claude استخدام MotoParts نيابةً عنك.',
    canHeading: 'سيتمكن Claude من',
    can: [
      'قراءة الدورات وأوامر الشراء والمخزون والمبيعات والمدفوعات والأرصدة وأسعار الصرف.',
      'تسجيل فواتير الموردين كأوامر شراء، وإدارة استلام الدورة: الموردون والمنتجات والدورات ومراحل الشحن وتأكيد دخول المخزون.',
    ],
    cannotHeading: 'لن يتمكن Claude من',
    cannot: [
      'تسجيل أو تعديل المبيعات أو المدفوعات أو الأقساط أو التسويات أو المرتجعات أو دفتر الحسابات.',
    ],
    confirm:
      'لا يتغير شيء قبل أن تؤكد معاينته. يُسجَّل كل شيء باسمك. يمكنك فصل Claude من الإعدادات في أي وقت.',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    submit: 'تسجيل الدخول والربط',
    switchTo: 'English',
    errorTitle: 'لا يمكن متابعة هذا الربط',
    errors: {
      wrong_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
      partners_only: 'يمكن للشركاء الأساسيين فقط ربط Claude.',
      inactive: 'هذا الحساب غير مفعّل.',
      unknown_client:
        'لم يتم التعرف على اتصال Claude هذا. ابدأ الربط من جديد من Claude.',
      unregistered_redirect:
        'هذا الطلب لم يأتِ من اتصال Claude الذي يذكره. ابدأ الربط من جديد من Claude.',
    } satisfies Record<PageError, string>,
  },
};

export function pageLang(value: unknown): PageLang {
  return value === 'ar' ? 'ar' : 'en';
}

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f3f4f6;color:#0f172a;padding:16px;
    font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
  main{width:100%;max-width:440px;background:#fff;border:1px solid #e5e7eb;
    border-radius:.75rem;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{font-size:1.25rem;margin:0 0 6px}
  p{margin:0 0 14px;line-height:1.5}
  h2{font-size:.85rem;margin:16px 0 6px;color:#374151}
  ul{margin:0;padding-inline-start:20px;line-height:1.5;font-size:.9rem;color:#374151}
  .note{font-size:.85rem;color:#4b5563;background:#eff6ff;border-radius:.5rem;
    padding:10px 12px;margin:16px 0}
  label{display:block;font-size:.85rem;font-weight:500;margin:12px 0 4px}
  input[type=email],input[type=password]{width:100%;padding:10px 12px;font:inherit;
    border:1px solid #d1d5db;border-radius:.5rem}
  button{width:100%;margin-top:18px;padding:11px;font:inherit;font-weight:600;color:#fff;
    background:#2563eb;border:0;border-radius:.5rem;cursor:pointer}
  button:hover{background:#1d4ed8}
  .error{background:#fef2f2;color:#b91c1c;border-radius:.5rem;padding:10px 12px;
    margin:12px 0;font-size:.9rem}
  .lang{display:block;text-align:end;font-size:.85rem;color:#2563eb;margin-bottom:8px}
`;

function shell(lang: PageLang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Arabic:wght@400;500;600&display=swap">
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * The sign-in form. `fields` are the authorization request, carried through
 * the POST as hidden inputs so the server can check all of it again — a hidden
 * field is the caller's to edit, and is never trusted for having been ours.
 */
export function renderSignInPage(options: {
  lang: PageLang;
  fields: Record<string, string | undefined>;
  error?: PageError;
  email?: string;
}): string {
  const t = TEXT[options.lang];
  const other: PageLang = options.lang === 'ar' ? 'en' : 'ar';

  const carried = Object.entries(options.fields).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const switchQuery = new URLSearchParams([...carried, ['lang', other]]);
  const hidden = carried
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n');

  const list = (items: string[]) =>
    `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;

  const body = `
<a class="lang" href="/oauth/authorize?${escapeHtml(switchQuery.toString())}">${t.switchTo}</a>
<h1>${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.lead)}</p>
<h2>${escapeHtml(t.canHeading)}</h2>
${list(t.can)}
<h2>${escapeHtml(t.cannotHeading)}</h2>
${list(t.cannot)}
<p class="note">${escapeHtml(t.confirm)}</p>
${options.error ? `<div class="error" role="alert" data-error="${options.error}">${escapeHtml(t.errors[options.error])}</div>` : ''}
<form method="post" action="/oauth/authorize">
${hidden}
<input type="hidden" name="lang" value="${options.lang}">
<label for="email">${escapeHtml(t.email)}</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(options.email ?? '')}">
<label for="password">${escapeHtml(t.password)}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">${escapeHtml(t.submit)}</button>
</form>`;
  return shell(options.lang, t.title, body);
}

/**
 * A request that cannot be answered by redirecting: the client is unknown, or
 * the redirect URI is not one it registered. Sending the browser there would
 * hand an error — or worse, later, a code — to an address nobody verified.
 */
export function renderErrorPage(lang: PageLang, error: PageError): string {
  const t = TEXT[lang];
  return shell(
    lang,
    t.errorTitle,
    `<h1>${escapeHtml(t.errorTitle)}</h1>
<div class="error" role="alert" data-error="${error}">${escapeHtml(t.errors[error])}</div>`,
  );
}
