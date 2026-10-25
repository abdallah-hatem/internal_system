/* eslint-disable @typescript-eslint/no-explicit-any -- API and stub payloads are parsed JSON; each assertion names the field it reads */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the office chat (owner 2026-10-20, built 2026-10-25)
 * ═══════════════════════════════════════════════════════════════════════
 *  Ask from the floating button; the API runs the assistant's own tools; a
 *  change comes back as a preview card and only its Confirm button saves it.
 *
 *  The model is a stand-in served here (an OpenAI-style chat endpoint on
 *  STUB_PORT), so the real tools, preview, token and database run without a
 *  paid provider. Run the API with
 *    AI_PROVIDER=stub AI_API_KEY=stub AI_BASE_URL=http://localhost:3199
 *  — otherwise this suite skips itself.
 *
 *  The stub: "dashboard" → get_dashboard; "PAY|<shop>|<amount>" →
 *  record_payment; after a tool, it repeats the tool's answer.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { API, apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { login, messages } from './support/ui';

const STUB_PORT = 3199;
const en = messages('en');
const seen: any[] = [];
let stub: Server;

function reply(body: any) {
  const last = body.messages[body.messages.length - 1];
  const say = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
  const call = (name: string, args: unknown) => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
  });
  if (last.role === 'tool') return say(`STUB: ${String(last.content).slice(0, 160)}`);
  const text = String(last.content);
  if (text.startsWith('PAY|')) {
    const [, customer, amount] = text.split('|');
    return call('record_payment', { customer, amount: Number(amount), method: 'CASH' });
  }
  if (/dashboard/i.test(text)) return call('get_dashboard', {});
  return say('Hello from the stub.');
}

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((r) => stub.listen(STUB_PORT, r));
});
test.afterAll(() => new Promise<void>((r) => stub.close(() => r())));

async function usingStub(request: APIRequestContext) {
  const { headers } = await apiCtx(request);
  const status = await (await request.get(`${API}/assistant/chat/status`, { headers })).json();
  return status.data?.provider === 'stub';
}

/** A shop owing 3,000, as the business makes one: stock through a cycle, a confirmed sale. */
async function owingShop(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const tag = `${label} ${Date.now()}`;
  const { product } = await stockedProduct(request, headers, mk, tag, 5);
  const shop = await mk('customers', { displayName: `${tag} Shop`, type: 'B2B' });
  await owedOrder(mk, shop.id, product.id, 3000);
  return { headers, shop };
}

/** What the shop owes now: its statement's closing balance (the balance the app shows, §7b). */
async function paymentsOf(request: APIRequestContext, headers: Record<string, string>, customerId: string) {
  const res = await request.get(`${API}/customers/${customerId}/statement`, { headers });
  return { balance: Number((await res.json()).data.closingBalance) };
}

test.describe('The office chat', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!(await usingStub(request)), 'the API is not pointed at the stand-in model (AI_PROVIDER=stub)');
  });

  test('TC-CHAT-01: a question answered from the assistant’s own tools; the model never sees a token field', async ({ page }) => {
    await login(page);
    await page.getByTestId('assistant-chat-open').click();
    const box = page.getByPlaceholder(en.assistantChat.placeholder);
    await box.fill('What does the dashboard say?');
    await box.press('Enter');
    await expect(page.getByTestId('assistant-chat-assistant').last()).toContainText('STUB:', { timeout: 30000 });
    await expect(page.getByTestId('assistant-chat-usage')).toContainText(/\d+ of 100/);
    const tools = seen[seen.length - 1].tools as any[];
    expect(tools.some((t) => t.function.name === 'get_dashboard')).toBe(true);
    // No tool offers the model a token field (a description may still say
    // "call without confirmationToken to preview").
    const offered = tools.filter((t) => 'confirmationToken' in (t.function.parameters?.properties ?? {}));
    expect(offered.map((t) => t.function.name)).toEqual([]);
  });

  test('TC-CHAT-02: a payment comes back as a preview; nothing is saved until Confirm, which saves it once', async ({ page, request }) => {
    const { headers, shop } = await owingShop(request, 'Chat02');
    const before = await paymentsOf(request, headers, shop.id);
    await login(page);
    await page.getByTestId('assistant-chat-open').click();
    const box = page.getByPlaceholder(en.assistantChat.placeholder);
    const answered = page.waitForResponse((r) => r.url().endsWith('/assistant/chat') && r.request().method() === 'POST');
    await box.fill(`PAY|${shop.displayName}|1000`);
    await box.press('Enter');
    const token = (await (await answered).json()).data.pending[0]?.token as string;
    expect(token).toBeTruthy();

    const card = page.getByTestId('assistant-chat-preview');
    await expect(card).toContainText(shop.displayName, { timeout: 30000 });
    // Previewed, not saved — and the model was never handed the token.
    expect((await paymentsOf(request, headers, shop.id)).balance).toBe(before.balance);
    expect(JSON.stringify(seen)).not.toContain(token);

    await page.getByTestId('assistant-chat-confirm').click();
    await expect(card).toHaveAttribute('data-state', 'saved', { timeout: 30000 });
    await expect(page.getByTestId('assistant-chat-confirm')).toHaveCount(0);
    expect((await paymentsOf(request, headers, shop.id)).balance).toBe(before.balance - 1000);

    // The same token again (a second click, a replay) saves nothing more.
    const replay = await request.post(`${API}/assistant/chat/confirm`, {
      headers,
      data: { tool: 'record_payment', args: { customer: shop.displayName, amount: 1000, method: 'CASH' }, token },
    });
    expect((await replay.json()).data.ok).toBe(false);
    expect((await paymentsOf(request, headers, shop.id)).balance).toBe(before.balance - 1000);
  });

  test('TC-CHAT-03: Cancel saves nothing', async ({ page, request }) => {
    const { headers, shop } = await owingShop(request, 'Chat03');
    const before = await paymentsOf(request, headers, shop.id);
    await login(page);
    await page.getByTestId('assistant-chat-open').click();
    const box = page.getByPlaceholder(en.assistantChat.placeholder);
    await box.fill(`PAY|${shop.displayName}|500`);
    await box.press('Enter');
    await page.getByTestId('assistant-chat-cancel').click({ timeout: 30000 });
    await expect(page.getByTestId('assistant-chat-outcome')).toHaveText(en.assistantChat.cancelled);
    expect((await paymentsOf(request, headers, shop.id)).balance).toBe(before.balance);
  });

  test('TC-CHAT-04: only core partners — anyone else is refused at the API with a code', async ({ request }) => {
    const res = await request.post(`${API}/assistant/chat`, { data: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.status()).toBe(401);
  });
});
