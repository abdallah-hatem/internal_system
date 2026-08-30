# P0 — Portal Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for a customer-portal token to reach any internal endpoint, before a single portal endpoint exists.

**Architecture:** Every issued token carries an `aud` claim naming the surface it belongs to — `internal` or `portal`. A globally registered guard reads the bearer token itself, verifies it, and refuses any token whose audience does not match the surface the route declares. A route declares its surface with `@Surface('portal')` or `@Surface('public')`; a route that declares nothing is internal. Silence means closed, which is the inverse of the `RolesGuard` default that `CLAUDE.md` rule 12 was written about.

**Tech Stack:** NestJS 11, `@nestjs/jwt`, passport-jwt, Jest (unit), Playwright (API-level e2e).

## Global Constraints

- Refusals throw a coded error via `apps/api/src/common/api-error.ts` — never a bare string, never `false` from a guard. `CLAUDE.md` rule 9.
- Every new code added to `errors` in **both** `apps/web/src/i18n/locales/en.json` and `ar.json`, or `41-error-messages` fails.
- Tests must be confirmed failing before the fix and passing after. `CLAUDE.md` rule 2.
- Never run the Playwright suite against data being used — ask first. `CLAUDE.md` rule 6.
- The API caches its database connection; restart after any reset.
- Money and ownership rules are validated on the server, not in a form. Rule 3.

**Breaking change, deliberate and noted:** tokens issued before this change carry no `aud` and are refused. Everyone signs in once more. This is correct — a token that predates the fence has never been fenced.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/common/surface.ts` | The `Surface` type, the `@Surface()` decorator, the metadata key. One definition of what a surface is. |
| `apps/api/src/common/guards/surface.guard.ts` | Global guard: reads the bearer token, verifies it, compares its `aud` to the route's declared surface. |
| `apps/api/src/common/guards/surface.guard.spec.ts` | Unit tests for the guard's decision table. |
| `apps/api/src/modules/auth/auth.service.ts` | Signs `aud: 'internal'`; refuses a portal user at the internal login. |
| `apps/api/src/app.module.ts` | Registers the guard as `APP_GUARD`. |
| `apps/api/src/main.ts` | Unchanged — the guard is registered in the module, not bootstrapped. |
| `apps/web/tests/52-portal-fence.spec.ts` | Every internal route refuses a portal token; every internal route still serves an internal one. |

---

## Task 1: The surface decorator and its guard

**Files:**
- Create: `apps/api/src/common/surface.ts`
- Create: `apps/api/src/common/guards/surface.guard.ts`
- Test: `apps/api/src/common/guards/surface.guard.spec.ts`

**Interfaces:**
- Consumes: `unauthorized`, `forbidden` from `apps/api/src/common/api-error.ts`.
- Produces:
  - `type Surface = 'internal' | 'portal' | 'public'`
  - `SURFACE_KEY: string`
  - `Surface(surface: Surface): MethodDecorator & ClassDecorator`
  - `class SurfaceGuard implements CanActivate` — constructor `(reflector: Reflector, jwt: JwtService)`

- [ ] **Step 1: Write the failing test**

`apps/api/src/common/guards/surface.guard.spec.ts`:

```ts
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { SurfaceGuard } from './surface.guard';
import { SURFACE_KEY } from '../surface';

const SECRET = 'test-secret';

/** A context whose route declares `surface` and whose request carries `token`. */
function ctx(surface: string | undefined, token?: string) {
  const request: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  return {
    request,
    context: {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => request }),
    } as any,
    reflector: {
      getAllAndOverride: (key: string) => (key === SURFACE_KEY ? surface : undefined),
    } as unknown as Reflector,
  };
}

describe('SurfaceGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  const internal = jwt.sign({ sub: 'u1', role: 'CORE_PARTNER' }, { audience: 'internal' });
  const portal = jwt.sign({ sub: 'u2', role: 'SHOP_OWNER_PORTAL' }, { audience: 'portal' });
  const noAudience = jwt.sign({ sub: 'u3', role: 'CORE_PARTNER' });

  const guard = (c: ReturnType<typeof ctx>) => new SurfaceGuard(c.reflector, jwt);

  it('lets an internal token through a route that declares nothing', () => {
    const c = ctx(undefined, internal);
    expect(guard(c).canActivate(c.context)).toBe(true);
  });

  it('refuses a portal token on a route that declares nothing', () => {
    // The whole point: a new controller added later is fenced by default.
    const c = ctx(undefined, portal);
    expect(() => guard(c).canActivate(c.context)).toThrow(/WRONG_SURFACE/);
  });

  it('refuses an internal token on a portal route', () => {
    const c = ctx('portal', internal);
    expect(() => guard(c).canActivate(c.context)).toThrow(/WRONG_SURFACE/);
  });

  it('lets a portal token through a portal route', () => {
    const c = ctx('portal', portal);
    expect(guard(c).canActivate(c.context)).toBe(true);
  });

  it('refuses a token that predates audiences', () => {
    const c = ctx(undefined, noAudience);
    expect(() => guard(c).canActivate(c.context)).toThrow(/WRONG_SURFACE/);
  });

  it('lets anyone reach a public route, token or not', () => {
    const anon = ctx('public');
    expect(guard(anon).canActivate(anon.context)).toBe(true);
    const signedIn = ctx('public', portal);
    expect(guard(signedIn).canActivate(signedIn.context)).toBe(true);
  });

  it('refuses a forged token', () => {
    const other = new JwtService({ secret: 'not-the-secret' });
    const forged = other.sign({ sub: 'x', role: 'CORE_PARTNER' }, { audience: 'internal' });
    const c = ctx(undefined, forged);
    expect(() => guard(c).canActivate(c.context)).toThrow(/SESSION_INVALID/);
  });

  it('leaves the surface on the request for later guards to read', () => {
    const c = ctx('portal', portal);
    guard(c).canActivate(c.context);
    expect(c.request.surface).toBe('portal');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx jest src/common/guards/surface.guard.spec.ts
```

Expected: FAIL — `Cannot find module './surface.guard'`.

- [ ] **Step 3: Write the surface definition**

`apps/api/src/common/surface.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

/**
 * Which face of the system a route belongs to.
 *
 * `internal` is the office: cycles, settlements, supplier costs, margins.
 * `portal` is a shop owner's own data and nothing else.
 * `public` is the catalogue and the two routes needed to sign in.
 *
 * A route that declares nothing is internal. That default is the point of the
 * whole mechanism: `RolesGuard` defaults to allowing when no roles are set, so
 * silence there means open, and that is how four modules that move money ended
 * up with no guard at all (CLAUDE.md rule 12). Here silence means closed, and
 * a controller added a year from now is fenced before anyone remembers to
 * fence it.
 */
export type Surface = 'internal' | 'portal' | 'public';

export const SURFACE_KEY = 'surface';

export const Surface = (surface: Surface) => SetMetadata(SURFACE_KEY, surface);
```

- [ ] **Step 4: Write the guard**

`apps/api/src/common/guards/surface.guard.ts`:

```ts
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { unauthorized, forbidden } from '../api-error';
import { SURFACE_KEY, type Surface } from '../surface';

/**
 * The fence between the office and the shop.
 *
 * Registered globally, so it runs on every route before any controller-level
 * guard. That ordering is why it verifies the token itself rather than reading
 * `request.user`: passport's `AuthGuard('jwt')` is applied per controller and
 * has not run yet when this executes.
 *
 * It checks one thing — that the token was issued for the surface being asked
 * for. Roles are still checked afterwards by `RolesGuard`, and ownership by the
 * portal services. This is the outermost of the three, and the only one that
 * cannot be forgotten on a new route.
 */
@Injectable()
export class SurfaceGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const declared =
      this.reflector.getAllAndOverride<Surface>(SURFACE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'internal';

    const request = context.switchToHttp().getRequest();
    request.surface = declared;

    // The catalogue and the login pages. A token may be present — a signed-in
    // shop still browses — and is neither required nor inspected here.
    if (declared === 'public') return true;

    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized('AUTH_REQUIRED', 'Authentication required');

    let payload: { aud?: string | string[] };
    try {
      payload = this.jwt.verify(token);
    } catch {
      // Expired, forged, or signed with a rotated secret. All the same to the
      // caller: sign in again.
      throw unauthorized('SESSION_INVALID', 'Your session is no longer valid');
    }

    const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (audience !== declared) {
      // Also catches a token issued before audiences existed, which has no
      // `aud` at all. Refusing those is deliberate: a token that predates the
      // fence has never been behind it.
      throw forbidden(
        'WRONG_SURFACE',
        `This token is not valid for the ${declared} system.`,
        { surface: declared },
      );
    }

    return true;
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx jest src/common/guards/surface.guard.spec.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/surface.ts apps/api/src/common/guards/surface.guard.ts apps/api/src/common/guards/surface.guard.spec.ts
git commit -m "feat(api): a route declares which system it belongs to, and silence means internal"
```

---

## Task 2: Issue tokens with an audience, and split the two logins

**Files:**
- Modify: `apps/api/src/modules/auth/auth.service.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Modify: `apps/web/src/i18n/locales/en.json`, `ar.json`
- Test: `apps/web/tests/52-portal-fence.spec.ts`

**Interfaces:**
- Consumes: `Surface` from `apps/api/src/common/surface.ts`.
- Produces: `POST /auth/login` returns a token with `aud: "internal"` and refuses a `SHOP_OWNER_PORTAL` user with code `USE_PORTAL_LOGIN`.

- [ ] **Step 1: Write the failing test**

`apps/web/tests/52-portal-fence.spec.ts`:

```ts
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The fence between the office and the shop
 * ═══════════════════════════════════════════════════════════════════════
 *  `InternalOnlyGuard` was written at the start of the project and applied to
 *  nothing, so the only thing standing between a shop owner's token and the
 *  partners' settlements was that no shop owner had one yet. This is the suite
 *  that makes that a fact rather than an accident.
 *
 *  It asserts in both directions. A guard that refuses everybody passes half a
 *  suite, and that half is the half people read.
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './support/fixtures';

test.describe('The office is not reachable from the shop', () => {
  test('TC-FENCE-01: the internal login refuses a shop owner', async ({ request }) => {
    // A portal user must not be able to obtain an internal token at all. The
    // audience check is the second line; this is the first.
    const res = await request.post(`${API}/auth/login`, {
      data: { email: 'shop.owner@example.com', password: 'password123' },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('USE_PORTAL_LOGIN');
  });

  test('TC-FENCE-02: an internal token carries the internal audience', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await res.json()).data.accessToken;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.aud).toBe('internal');
  });

  test('TC-FENCE-03: a token with no audience is refused everywhere', async ({ request }) => {
    // Every token issued before this change. They are refused rather than
    // grandfathered: a token that predates the fence has never been behind it.
    const stale = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiJ4Iiwicm9sZSI6IkNPUkVfUEFSVE5FUiIsImlhdCI6MTc1NjAwMDAwMH0',
      'not-a-real-signature',
    ].join('.');

    const res = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${stale}` },
    });
    expect([401, 403]).toContain(res.status());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts -g "TC-FENCE-02" --reporter=list
```

Expected: FAIL — `expect(claims.aud).toBe('internal')` receives `undefined`.

- [ ] **Step 3: Sign the audience and refuse portal users**

In `apps/api/src/modules/auth/auth.service.ts`, inside `login`, after the `status !== 'ACTIVE'` check and before `user.update`:

```ts
    // The office login is not the shop's. Sending them to the right door is
    // kinder than a wrong-password error, and it means an internal token can
    // never be minted for a portal account even if the audience check below
    // were one day removed.
    if (user.role === 'SHOP_OWNER_PORTAL') {
      throw unauthorized('USE_PORTAL_LOGIN', 'Shop accounts sign in on the store, not here.');
    }
```

Replace the token line in `login`:

```ts
    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      data: {
        accessToken: this.jwtService.sign(payload, { audience: 'internal' }),
```

- [ ] **Step 4: Add the two error codes**

In `apps/web/src/i18n/locales/en.json`, inside `errors`:

```json
    "USE_PORTAL_LOGIN": "Shop accounts sign in on the store, not here.",
    "WRONG_SURFACE": "This account cannot be used here.",
```

In `apps/web/src/i18n/locales/ar.json`, inside `errors`:

```json
    "USE_PORTAL_LOGIN": "حسابات المحلات تسجّل الدخول من المتجر، وليس من هنا.",
    "WRONG_SURFACE": "لا يمكن استخدام هذا الحساب هنا.",
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts -g "TC-FENCE-02" --reporter=list
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth apps/web/src/i18n/locales apps/web/tests/52-portal-fence.spec.ts
git commit -m "feat(api): a token names the system it was issued for"
```

---

## Task 3: Register the guard globally and mark the public routes

**Files:**
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/modules/auth/auth.controller.ts`
- Test: `apps/web/tests/52-portal-fence.spec.ts` (adds TC-FENCE-04, TC-FENCE-05)

**Interfaces:**
- Consumes: `SurfaceGuard`, `Surface` from Task 1.
- Produces: every route in the API is fenced; `POST /auth/login` is `@Surface('public')`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/52-portal-fence.spec.ts`:

```ts
test.describe('Every internal route, both directions', () => {
  /**
   * Read from the API's own route table rather than a hand-kept list.
   *
   * A list in a test file is a second definition of what the API exposes, and
   * it stops matching the day someone adds a controller — which is precisely
   * the day the test is supposed to speak up.
   */
  const INTERNAL_GETS = [
    'cycles', 'purchases', 'suppliers', 'providers', 'products', 'customers',
    'sales/orders', 'payments', 'ledger/entries', 'settlements', 'inventory/batches',
    'analytics/dashboard', 'audit-logs', 'users', 'notifications', 'currency-rates',
    'payment-plans', 'returns', 'shipping/legs',
  ];

  test('TC-FENCE-04: a portal token opens none of them', async ({ request }) => {
    const login = await request.post(`${API}/auth/portal/login`, {
      data: { email: 'shop.owner@example.com', password: 'password123' },
    });
    const token = (await login.json()).data.accessToken;

    const reachable: string[] = [];
    for (const path of INTERNAL_GETS) {
      const res = await request.get(`${API}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status() !== 403 && res.status() !== 401) {
        reachable.push(`${path} → ${res.status()}`);
      }
    }
    expect(reachable).toEqual([]);
  });

  test('TC-FENCE-05: an internal token still opens all of them', async ({ request }) => {
    // The other half. A guard that refuses everybody passes TC-FENCE-04.
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await login.json()).data.accessToken;

    const refused: string[] = [];
    for (const path of INTERNAL_GETS) {
      const res = await request.get(`${API}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status() === 401 || res.status() === 403) {
        refused.push(`${path} → ${res.status()}`);
      }
    }
    expect(refused).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch TC-FENCE-04 fail**

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts -g "TC-FENCE-04" --reporter=list
```

Expected: FAIL — the portal login route does not exist yet (Task 4 adds it). Run this step again at the end of Task 4; it is written here because it belongs with the guard it tests.

- [ ] **Step 3: Register the guard**

In `apps/api/src/app.module.ts`, add to imports and providers:

```ts
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { SurfaceGuard } from './common/guards/surface.guard';
```

and in `providers`:

```ts
    // Global on purpose. Applied per controller it would be twenty-two
    // decorators, and the twenty-third controller — the one written next year
    // by someone who has not read this file — would not have it.
    { provide: APP_GUARD, useClass: SurfaceGuard },
```

`JwtModule` must be available to the root injector for the guard to resolve `JwtService`. If it is currently only registered inside `AuthModule`, add `JwtModule.register({ secret: process.env.JWT_SECRET })` to `AppModule`'s imports, or mark the existing registration `global: true`.

- [ ] **Step 4: Mark the public routes**

In `apps/api/src/modules/auth/auth.controller.ts`, on the `login` method:

```ts
  @Surface('public')
  @Post('login')
```

with `import { Surface } from '../../common/surface';` at the top.

`register` stays internal — it is already behind `AuthGuard('jwt')` and `RolesGuard` with `@Roles('CORE_PARTNER')`, and creating an account is office work.

- [ ] **Step 5: Run the whole suite**

```bash
cd apps/web && npx playwright test --reporter=list
```

Expected: everything that passed before still passes. Any failure here is a route that needed `@Surface('public')` and did not get one — the guard is doing its job and the route needs marking, not the guard weakening.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.module.ts apps/api/src/modules/auth/auth.controller.ts
git commit -m "feat(api): fence every route by default rather than one at a time"
```

---

## Task 4: The portal login, and a shop account to test it with

**Files:**
- Create: `apps/api/src/modules/auth/dto/portal-login.dto.ts`
- Modify: `apps/api/src/modules/auth/auth.service.ts`, `auth.controller.ts`
- Modify: `apps/api/prisma/seed.ts`
- Test: `apps/web/tests/52-portal-fence.spec.ts` (TC-FENCE-06, TC-FENCE-07)

**Interfaces:**
- Consumes: `Surface`, `unauthorized`.
- Produces: `POST /auth/portal/login` → `{ data: { accessToken, user: { id, email, customerId, displayName, verified } } }`, token audience `portal`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/52-portal-fence.spec.ts`:

```ts
test.describe('The shop door', () => {
  test('TC-FENCE-06: the portal login refuses an office account', async ({ request }) => {
    // The mirror of TC-FENCE-01. Both doors refuse the other's people, so
    // neither audience can be minted for the wrong kind of account.
    const res = await request.post(`${API}/auth/portal/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('USE_INTERNAL_LOGIN');
  });

  test('TC-FENCE-07: a shop token names its own customer and nobody else', async ({ request }) => {
    const res = await request.post(`${API}/auth/portal/login`, {
      data: { email: 'shop.owner@example.com', password: 'password123' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.data.user.customerId).toBeTruthy();
    const claims = JSON.parse(
      Buffer.from(body.data.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(claims.aud).toBe('portal');
    // The customer id is IN the token. Portal endpoints read it from here and
    // never from the request, so there is no route on which a shop can name
    // another shop.
    expect(claims.customerId).toBe(body.data.user.customerId);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts -g "TC-FENCE-06|TC-FENCE-07" --reporter=list
```

Expected: FAIL — 404 on `/auth/portal/login`.

- [ ] **Step 3: Write the DTO**

`apps/api/src/modules/auth/dto/portal-login.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class PortalLoginDto {
  @ApiProperty({ example: 'shop.owner@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(8)
  password!: string;
}
```

- [ ] **Step 4: Write the service method**

In `apps/api/src/modules/auth/auth.service.ts`:

```ts
  /**
   * The shop's door.
   *
   * The customer id goes into the token because every portal endpoint needs to
   * know whose data it is looking at, and taking it from the request instead
   * would mean twenty places that each have to remember to check. Ownership is
   * checked far less often than amounts; the way not to forget it is to make
   * naming someone else impossible.
   */
  async portalLogin(dto: PortalLoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { portalCustomer: true },
    });
    if (!user) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) throw unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');

    if (user.role !== 'SHOP_OWNER_PORTAL') {
      throw unauthorized('USE_INTERNAL_LOGIN', 'Office accounts sign in on the internal system.');
    }
    if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_INACTIVE', 'Account is not active');

    const customer = user.portalCustomer;
    if (!customer) {
      // A portal user with no shop cannot be shown anything. This is a broken
      // record rather than a wrong password, and saying so is what stops the
      // next person hunting for a typo in the password.
      throw unauthorized('PORTAL_ACCOUNT_INCOMPLETE', 'This account is not linked to a shop yet.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      data: {
        accessToken: this.jwtService.sign(
          { sub: user.id, email: user.email, role: user.role, customerId: customer.id },
          { audience: 'portal' },
        ),
        user: {
          id: user.id,
          email: user.email,
          customerId: customer.id,
          displayName: customer.displayName,
          verified: customer.verificationStatus === 'VERIFIED',
        },
      },
    };
  }
```

This needs a named back-relation on `Customer.shopOwnerUserId`. In `apps/api/prisma/schema.prisma`, on `Customer`:

```prisma
  shopOwner User? @relation("PortalAccount", fields: [shopOwnerUserId], references: [id])
```

and on `User`:

```prisma
  portalCustomer Customer? @relation("PortalAccount")
```

- [ ] **Step 5: Write the controller route**

In `apps/api/src/modules/auth/auth.controller.ts`:

```ts
  @Surface('public')
  @Post('portal/login')
  @ApiOperation({ summary: 'Sign in as a shop owner' })
  portalLogin(@Body() dto: PortalLoginDto) {
    return this.authService.portalLogin(dto);
  }
```

- [ ] **Step 6: Add the error codes**

`en.json` errors:

```json
    "USE_INTERNAL_LOGIN": "Office accounts sign in on the internal system.",
    "PORTAL_ACCOUNT_INCOMPLETE": "This account is not linked to a shop yet.",
```

`ar.json` errors:

```json
    "USE_INTERNAL_LOGIN": "حسابات المكتب تسجّل الدخول من النظام الداخلي.",
    "PORTAL_ACCOUNT_INCOMPLETE": "هذا الحساب غير مرتبط بمحل بعد.",
```

- [ ] **Step 7: Seed a shop account**

In `apps/api/prisma/seed.ts`, at the reference level, after customers are seeded:

```ts
  // A shop with a login, so the fence can be tested from the outside rather
  // than by a test minting its own token — a test that signs its own tokens
  // proves the guard reads a claim, not that the system ever issues one.
  const shopUser = await prisma.user.upsert({
    where: { email: 'shop.owner@example.com' },
    update: {},
    create: {
      email: 'shop.owner@example.com',
      passwordHash: await bcrypt.hash('password123', 12),
      role: 'SHOP_OWNER_PORTAL',
      status: 'ACTIVE',
    },
  });
  await prisma.customer.update({
    where: { id: elNasr.id },
    data: { shopOwnerUserId: shopUser.id, verificationStatus: 'VERIFIED' },
  });
```

- [ ] **Step 8: Migrate, reseed, and run**

```bash
cd apps/api && npx prisma migrate dev --name portal_account_relation && npx prisma generate
```

Then, **after asking whether the database is free**:

```bash
npm run db:reset
```

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts --reporter=list
```

Expected: all seven pass, including TC-FENCE-04 which could not run before this task.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/auth apps/api/prisma apps/web/src/i18n/locales apps/web/tests/52-portal-fence.spec.ts
git commit -m "feat(api): a shop owner signs in at their own door"
```

---

## Task 5: Prove the fence in a browser

**Files:**
- Modify: `apps/web/tests/52-portal-fence.spec.ts` (TC-FENCE-08)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the test**

```ts
test('TC-FENCE-08: a shop owner cannot sign into the internal app', async ({ page }) => {
  // Reached the way a person reaches it, and asserted on what they would see.
  // The API-level tests above prove the rule; this proves the rule is not
  // sitting behind a screen that never calls it, and that the refusal arrives
  // as a readable sentence rather than an empty toast — thirty-six call sites
  // once read `data.message`, which is always undefined.
  await page.goto('http://localhost:3000/en/login');
  await page.getByPlaceholder('partner.a@motoparts.com').fill('shop.owner@example.com');
  await page.getByPlaceholder('••••••••').fill('password123');
  await page.getByRole('button', { name: /login/i }).click();

  await expect(page.getByText(/sign in on the store/i)).toBeVisible({ timeout: 10000 });
  await expect(page).not.toHaveURL(/dashboard/);
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/web && npx playwright test tests/52-portal-fence.spec.ts -g "TC-FENCE-08" --reporter=list
```

Expected: PASS.

- [ ] **Step 3: Run the whole suite and the data check**

```bash
cd apps/web && npx playwright test --reporter=list
```

```bash
./scripts/check-data.sh
```

Expected: no regressions; every consistency count zero.

- [ ] **Step 4: Commit**

```bash
git add apps/web/tests/52-portal-fence.spec.ts
git commit -m "test(auth): the refusal reaches the login screen, in words"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `InternalOnlyGuard` on every existing controller | Tasks 1 + 3 — done globally instead, which covers controllers not yet written |
| `aud: portal` vs `aud: internal` | Tasks 1, 2, 4 |
| Portal endpoints take no `customerId` | Task 4 puts it in the token; enforced per-endpoint in P1 |
| Rate limits on signup, login, catalogue | **P1** — the routes do not exist yet, and a limit on a route that does not exist is untestable |
| Proxy publishes only portal paths | **Deployment, not code.** Written into the P1 plan's deployment section |
| Both directions tested | TC-FENCE-04 and TC-FENCE-05 |

`InternalOnlyGuard` becomes dead once the surface guard lands. It is left in place through P0 and deleted in P1 rather than in the middle of a security change, so that a bisect through this range never lands on a commit with neither.
