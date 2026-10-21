/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant's category tools, over /mcp
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16, "Categories" (owner 2026-10-15: "give the assistant
 *  create category"). `create_category` goes through the office's own
 *  `ProductsService.createCategory`; `list_categories` reads the office's list.
 *
 *  Driven the way Claude drives them: JSON-RPC `tools/call` on /mcp with an
 *  assistant token, a preview first and the same arguments again with its
 *  token. What was made is then found the way a partner finds it: signed in,
 *  clicking to Categories from the menu.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, EMAIL, investorSession, PASSWORD } from './support/fixtures';
import { assistantToken, mcpTokenFor } from './support/assistant-token';
import { WEB as BASE } from './support/env';
import { openView } from './support/ui';

const ROOT = API.replace(/\/api\/v1\/?$/, '');
const MCP = `${ROOT}/mcp`;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    status?: string;
    confirmationToken?: string;
    data?: any;
    error?: { code: string; message: string; params?: Record<string, unknown> };
  };
}

let nextId = 1;

function post(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  return request.post(MCP, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${token}`,
    },
    data: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
  });
}

async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await post(request, token, name, args);
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as ToolResult;
}

const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;

/**
 * The category list is sorted by name and paged. A key that shrinks as time
 * passes puts this run's categories first, ahead of every earlier test's.
 */
const key = () => `0${9_000_000_000_000 - Date.now()}`;

async function categories(request: APIRequestContext, headers: Record<string, string>): Promise<any[]> {
  const res = await request.get(`${API}/categories`, { headers });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data;
}

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('the assistant and categories', () => {
  test('TC-MCP-CAT-01: list_categories shows a category made in the office, with its parent; no Arabic name is null', async ({
    request,
  }) => {
    const { mk } = await apiCtx(request);
    const k = key();
    const parent = await mk('categories', { name: `${k} Brakes`, nameAr: `فرامل ${k}` });
    const child = await mk('categories', { name: `${k} Brake pads`, parentId: parent.id });
    const token = await assistantToken(request);

    const r = await callTool(request, token, 'list_categories', {});

    expect(r.isError).toBeFalsy();
    const rows = r.structuredContent!.data as any[];
    expect(rows.find((c) => c.id === child.id)).toEqual({
      id: child.id,
      name: child.name,
      nameAr: null,
      parentId: parent.id,
      parent: parent.name,
      parentAr: `فرامل ${k}`,
      products: 0,
    });
  });

  test('TC-MCP-CAT-02: a category made through the assistant, under a parent named in Arabic spelled another way, appears on the Categories page', async ({
    request,
    page,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const k = key();
    const parent = await mk('categories', { name: `${k} Lighting`, nameAr: `إضاءة ${k}` });
    const token = await assistantToken(request);
    const args = { name: `${k} Headlights`, parent: `اضاءه ${k}` };
    const before = (await categories(request, headers)).length;

    const preview = await callTool(request, token, 'create_category', args);
    expect(preview.structuredContent?.status, JSON.stringify(preview.structuredContent)).toBe('preview');
    expect(preview.content[0].text).toContain(`under ${parent.name} (إضاءة ${k})`);
    // A preview writes nothing (§16).
    expect((await categories(request, headers)).length).toBe(before);

    const commit = await callTool(request, token, 'create_category', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    expect(commit.structuredContent?.status, JSON.stringify(commit.structuredContent)).toBe('committed');
    const made = (await categories(request, headers)).find((c) => c.name === args.name);
    expect(made).toMatchObject({ parentId: parent.id, nameAr: null });

    // The same token again makes nothing more.
    const again = await callTool(request, token, 'create_category', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect((await categories(request, headers)).filter((c) => c.name === args.name)).toHaveLength(1);

    // Seen the way a partner sees it: signed in, clicking to Categories.
    await login(page);
    // Categories are a tab of Products since 2026-10-18.
    await openView(page, 'categories');
    const row = page.getByTestId('category-row').filter({ has: page.getByText(args.name, { exact: true }) });
    await expect(row).toBeVisible();
    await expect(page.getByRole('main').getByText(parent.name, { exact: true })).toBeVisible();
  });

  test('TC-MCP-CAT-03: a name taken in either language, an unknown parent and an ambiguous one are coded refusals; nothing is written', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const k = key();
    await mk('categories', { name: `${k} Tyres`, nameAr: `كاوتش ${k}` });
    await mk('categories', { name: `${k} Bags`, nameAr: `شنطة ${k}` });
    await mk('categories', { name: `${k} Body kit`, nameAr: `شنطه ${k}` });
    const token = await assistantToken(request);
    const before = (await categories(request, headers)).length;

    const sameName = await callTool(request, token, 'create_category', { name: `${k} Tyres` });
    const sameAr = await callTool(request, token, 'create_category', { name: `${k} Tubes`, nameAr: `كاوتش ${k}` });
    const unknown = await callTool(request, token, 'create_category', { name: `${k} Tubes`, parent: `${k} Exhausts` });
    const ambiguous = await callTool(request, token, 'create_category', { name: `${k} Side`, parent: `شنطة ${k}` });
    const blank = await callTool(request, token, 'create_category', { name: '   ' });

    expect(codeOf(sameName)).toBe('CATEGORY_NAME_TAKEN');
    expect(codeOf(sameAr)).toBe('CATEGORY_NAME_AR_TAKEN');
    expect(codeOf(unknown)).toBe('CATEGORY_PARENT_NOT_FOUND');
    expect(codeOf(ambiguous)).toBe('CATEGORY_PARENT_AMBIGUOUS');
    expect(String(ambiguous.structuredContent?.error?.params?.candidates)).toContain(`${k} Bags`);
    expect(String(ambiguous.structuredContent?.error?.params?.candidates)).toContain(`${k} Body kit`);
    expect(codeOf(blank)).toBe('VALIDATION_FAILED');
    expect((await categories(request, headers)).length).toBe(before);
  });

  test('TC-MCP-CAT-04: an investor can neither create a category in the office nor reach the tool; a core partner can', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    // An investor cannot sign in at the office (2026-10-19); investorSession's
    // hand-signed token reaches the guard.
    const investor = await investorSession(request, 'cat');
    const investorId = investor.user.id;
    const investorHeaders = investor.headers;
    const k = key();

    const office = await request.post(`${API}/categories`, { headers: investorHeaders, data: { name: `${k} Inv` } });
    expect(office.status()).toBe(403);
    expect((await office.json()).error.code).toBe('ROLE_NOT_ALLOWED');

    const viaAssistant = await post(request, mcpTokenFor(investorId), 'create_category', { name: `${k} Inv` });
    expect(viaAssistant.status()).toBe(403);
    expect((await viaAssistant.json()).error.code).toBe('ASSISTANT_PARTNERS_ONLY');
    expect((await categories(request, headers)).find((c) => c.name === `${k} Inv`)).toBeUndefined();

    // The other direction: the core partner is allowed.
    const token = await assistantToken(request);
    const preview = await callTool(request, token, 'create_category', { name: `${k} Partner` });
    expect(preview.structuredContent?.status).toBe('preview');
  });
});
