/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Changing your password in Settings (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  Every change failed. The form posted `currentPassword` and the API read
 *  `oldPassword`, so bcrypt compared against `undefined` and answered 500 —
 *  shown as a generic "error". The form had already reset itself by then,
 *  before the answer came back, so the reader lost all three fields too. A
 *  confirmation that did not match did nothing at all, silently. And there
 *  was no rule on the new password.
 *
 *  Each account here is made for the test, so no other suite's password
 *  moves. Everything is reached by clicking: the sidebar to Settings, the
 *  header's account menu to log out.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';
import { WEB as BASE } from './support/env';

const START = 'password123';
const NEW = 'StrongPassword@123';
const DESKTOP = { width: 1440, height: 900 };

/** `next dev`'s overlay sits over the bottom corner; hidden, never clicked through. */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important }';
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
});

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

/** A fresh office account, made by a partner — its password is this test's alone. */
async function freshAccount(request: APIRequestContext) {
  const { headers } = await apiCtx(request);
  const email = `pw-${stamp()}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: START, displayName: `Password ${stamp()}`, role: 'ADMIN_SUPPORT' },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  return email;
}

/**
 * The login page is a fresh load, and a `fill` that lands before React
 * hydrates is thrown away (56-production). Fill, and check it stuck.
 */
async function typeLogin(page: Page, email: string, password: string) {
  const emailBox = page.getByPlaceholder('name@company.com');
  const passwordBox = page.getByPlaceholder('StrongPassword@123');
  await expect
    .poll(
      async () => {
        await emailBox.fill(email);
        await passwordBox.fill(password);
        await page.waitForTimeout(100);
        return (await emailBox.inputValue()) === email && (await passwordBox.inputValue()) === password;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.locator('button[type="submit"]').click();
}

async function signIn(page: Page, email: string, password: string, locale: 'en' | 'ar' = 'en') {
  await typeLogin(page, email, password);
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard`), { timeout: 15000 });
}

async function openSettings(page: Page, locale: 'en' | 'ar' = 'en') {
  const name = locale === 'ar' ? 'الإعدادات' : 'Settings';
  await page.getByRole('link', { name, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/settings$`));
}

const labels = {
  en: { current: 'Current Password', next: 'New Password', confirm: 'Confirm Password', submit: 'Change Password' },
  ar: { current: 'كلمة المرور الحالية', next: 'كلمة المرور الجديدة', confirm: 'تأكيد كلمة المرور', submit: 'تغيير كلمة المرور' },
};

function form(page: Page, locale: 'en' | 'ar' = 'en') {
  const l = labels[locale];
  return {
    current: page.getByLabel(l.current, { exact: true }),
    next: page.getByLabel(l.next, { exact: true }),
    confirm: page.getByLabel(l.confirm, { exact: true }),
    submit: page.getByRole('main').getByRole('button', { name: l.submit }),
  };
}

/** Types as a person does, key by key, so the controlled fields see every change. */
async function fillForm(page: Page, values: { current: string; next: string; confirm: string }, locale: 'en' | 'ar' = 'en') {
  const f = form(page, locale);
  await f.current.pressSequentially(values.current);
  await f.next.pressSequentially(values.next);
  await f.confirm.pressSequentially(values.confirm);
  return f;
}

async function logOut(page: Page, label = 'Log out') {
  await page.getByTestId('account-menu-trigger').click();
  await page.getByTestId('account-menu').getByRole('button', { name: label }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** Counts what actually reaches the API. */
function watchChanges(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/auth/change-password') && r.method() === 'POST') seen.push(r.postData() ?? '');
  });
  return seen;
}

test.describe('Change password', () => {
  test('TC-PW-01: change it, log out, and only the new password opens the door', async ({ page, request }) => {
    const email = await freshAccount(request);
    await page.goto(`${BASE}/en/login`);
    await signIn(page, email, START);
    await openSettings(page);

    const f = await fillForm(page, { current: START, next: NEW, confirm: NEW });
    await f.submit.click();

    await expect(page.getByText('Password changed successfully').first()).toBeVisible();
    // Cleared on success, and only then.
    await expect(f.current).toHaveValue('');
    await expect(f.next).toHaveValue('');
    await expect(f.confirm).toHaveValue('');
    // The session is kept: still signed in, still able to move around.
    await expect(page).toHaveURL(/\/en\/settings$/);
    await page.getByRole('link', { name: 'Customers', exact: true }).first().click();
    await expect(page).toHaveURL(/\/en\/customers$/);

    await logOut(page);

    await typeLogin(page, email, START);
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
    await expect(page).toHaveURL(/\/en\/login$/);

    await signIn(page, email, NEW);
  });

  test('TC-PW-02: a confirmation that does not match is said under it, and nothing is sent', async ({ page, request }) => {
    const email = await freshAccount(request);
    await page.goto(`${BASE}/en/login`);
    await signIn(page, email, START);
    await openSettings(page);
    const sent = watchChanges(page);

    const f = await fillForm(page, { current: START, next: NEW, confirm: 'StrongPassword@124' });
    await f.submit.click();

    await expect(page.getByTestId('confirmPassword-error')).toHaveText("The two new passwords don't match");
    await expect(f.confirm).toHaveAttribute('aria-invalid', 'true');
    // Kept, all three.
    await expect(f.current).toHaveValue(START);
    await expect(f.next).toHaveValue(NEW);
    await expect(f.confirm).toHaveValue('StrongPassword@124');
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);

    // Fixing it is the second visit: the message goes and the change goes through.
    await f.confirm.press('Backspace');
    await f.confirm.pressSequentially('3');
    await expect(page.getByTestId('confirmPassword-error')).toHaveCount(0);
    await f.submit.click();
    await expect(page.getByText('Password changed successfully').first()).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ currentPassword: START, newPassword: NEW });
  });

  test('TC-PW-03: in Arabic, a wrong current password is said in Arabic and the fields are kept', async ({ page, request }) => {
    const email = await freshAccount(request);
    await page.goto(`${BASE}/ar/login`);
    await signIn(page, email, START, 'ar');
    await openSettings(page, 'ar');

    const f = await fillForm(page, { current: 'NotMyPassword9', next: NEW, confirm: NEW }, 'ar');
    await f.submit.click();

    const refusal = page.getByTestId('password-refusal');
    await expect(refusal).toHaveText('كلمة المرور الحالية غير صحيحة.');
    await expect(refusal).not.toContainText(/[A-Za-z]/);
    await expect(f.current).toHaveValue('NotMyPassword9');
    await expect(f.next).toHaveValue(NEW);
    await expect(f.confirm).toHaveValue(NEW);

    // Correcting the current password and sending again works.
    await f.current.fill('');
    await f.current.pressSequentially(START);
    await expect(refusal).toHaveCount(0);
    await f.submit.click();
    await expect(page.getByText('تم تغيير كلمة المرور').first()).toBeVisible();

    await logOut(page, 'تسجيل الخروج');
    await signIn(page, email, NEW, 'ar');
  });

  test('TC-PW-04: the rule is shown as a hint, with placeholders that obey it', async ({ page, request }) => {
    const email = await freshAccount(request);
    await page.goto(`${BASE}/en/login`);
    await signIn(page, email, START);
    await openSettings(page);
    const f = form(page);

    await expect(f.current).toHaveAttribute('placeholder', 'YourCurrentPassword1');
    await expect(f.next).toHaveAttribute('placeholder', 'StrongPassword@123');
    await expect(f.confirm).toHaveAttribute('placeholder', 'StrongPassword@123');
    await expect(page.locator('#newPassword-hint')).toHaveText(
      'At least 8 characters, with a letter and a digit, and different from your current one.',
    );
    await expect(f.next).toHaveAttribute('aria-describedby', /newPassword-hint/);
  });

  test('TC-PW-05: a weak or unchanged new password is refused with the rule, and nothing is sent', async ({ page, request }) => {
    const email = await freshAccount(request);
    await page.goto(`${BASE}/en/login`);
    await signIn(page, email, START);
    await openSettings(page);
    const sent = watchChanges(page);

    const f = await fillForm(page, { current: START, next: 'onlyletters', confirm: 'onlyletters' });
    await f.submit.click();
    await expect(page.getByTestId('newPassword-error')).toHaveText(
      'A password needs at least 8 characters, with at least one letter and one digit.',
    );
    await expect(f.next).toHaveValue('onlyletters');

    await f.next.fill('');
    await f.confirm.fill('');
    await f.next.pressSequentially(START);
    await f.confirm.pressSequentially(START);
    await f.submit.click();
    await expect(page.getByTestId('newPassword-error')).toHaveText(
      'The new password must be different from your current one.',
    );
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
  });

  test('TC-PW-06: the server refuses the same things when the form is bypassed', async ({ request }) => {
    const email = await freshAccount(request);
    const login = await request.post(`${API}/auth/login`, { data: { email, password: START } });
    const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    const post = async (data: unknown) => {
      const res = await request.post(`${API}/auth/change-password`, { headers, data });
      return { status: res.status(), code: (await res.json())?.error?.code };
    };

    expect(await post({ currentPassword: START, newPassword: 'short1' })).toEqual({ status: 400, code: 'PASSWORD_TOO_WEAK' });
    expect(await post({ currentPassword: START, newPassword: START })).toEqual({ status: 400, code: 'PASSWORD_SAME_AS_CURRENT' });
    expect(await post({ currentPassword: 'wrongWrong1', newPassword: NEW })).toEqual({ status: 400, code: 'WRONG_CURRENT_PASSWORD' });
    expect(await post({ oldPassword: START, newPassword: NEW })).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await post({})).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    const anon = await request.post(`${API}/auth/change-password`, { data: { currentPassword: START, newPassword: NEW } });
    expect(anon.status()).toBe(401);
  });
});
