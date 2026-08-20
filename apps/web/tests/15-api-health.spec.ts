/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: API Health & Integration Tests
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: API endpoints respond correctly, auth flow, CRUD via API
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

let token = '';

test.describe('API Health & Integration', () => {

  test('TC-API-01: API is running and responds (unauthenticated returns 401)', async ({ request }) => {
    const res = await request.get(`${API}/products`);
    // API requires auth, so 401 means it's running correctly
    expect(res.status()).toBe(401);
  });

  test('TC-API-02: Login returns access token', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.accessToken).toBeTruthy();
    token = body.data.accessToken;
  });

  test('TC-API-03: Authenticated request succeeds', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();
    token = data.accessToken;

    const res = await request.get(`${API}/products`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data).toBeDefined();
  });

  test('TC-API-04: Unauthenticated request returns 401', async ({ request }) => {
    const res = await request.get(`${API}/products`);
    expect(res.status()).toBe(401);
  });

  test('TC-API-05: Products endpoint returns array', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/products`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.data.length).toBeGreaterThan(0);
  });

  test('TC-API-06: Categories endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/categories`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-07: Cycles endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-08: Customers endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/customers`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-09: Sales orders endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/sales/orders`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-10: Payments endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/payments`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-11: Ledger endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/ledger`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-12: Audit logs endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/audit-logs`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-13: Inventory endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/inventory`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-14: Dashboard analytics endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/analytics/dashboard`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('TC-API-15: Suppliers endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/suppliers`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-16: Notifications endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/notifications`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-17: Settlements endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/settlements`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-18: Purchases endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/purchases`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-19: Providers endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/providers`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-20: Users endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/users`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-21: Auth profile endpoint returns user data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/auth/profile`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.email).toBe(EMAIL);
  });

  test('TC-API-22: Invalid login returns error', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: 'wrong@example.com', password: 'wrongpass' },
    });
    expect(res.status()).toBe(401);
  });

  test('TC-API-23: Shipping legs endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/shipping/legs`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
  });

  test('TC-API-24: Revenue by month endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/analytics/revenue-by-month?months=12`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('TC-API-25: Top products endpoint returns data', async ({ request }) => {
    const loginRes = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const { data } = await loginRes.json();

    const res = await request.get(`${API}/analytics/top-products?limit=10`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
  });
});
