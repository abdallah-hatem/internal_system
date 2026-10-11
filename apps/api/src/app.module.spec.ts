/* eslint-disable no-restricted-properties -- boot reads its settings from the environment; this spec sets test values there before AppModule is loaded */
import { Test } from '@nestjs/testing';

/**
 * The whole application's wiring, in a unit run (I2, 2026-10-11).
 *
 * I1 gave SalesService an `@Inject(NotificationsService)` its module did not
 * provide. Every unit test built SalesService by hand and passed; only the e2e
 * suite, which boots the real API, found that the server would not start.
 * Compiling AppModule resolves every provider of every module exactly as boot
 * does, so a missing dependency fails here, in seconds, with Nest's own
 * "can't resolve dependencies" message.
 *
 * `compile()` builds the providers but does not run `onModuleInit`, so
 * PrismaService never connects: no database is needed. The settings it reads
 * at construction are given test values — never the developer's or
 * production's. The real JWT secret check (`common/jwt-secret.ts`) runs and
 * must accept the value below.
 */
describe('AppModule', () => {
  const saved = { ...process.env };

  beforeAll(() => {
    process.env.JWT_SECRET = 'app-module-spec-secret-0123456789abcdefghij';
    process.env.DATABASE_URL =
      'postgresql://test:test@localhost:5/app_module_spec_never_connected';
    process.env.CRON_SECRET = 'app-module-spec-cron-secret';
  });

  afterAll(() => {
    process.env = saved;
  });

  it('compiles: every provider in every module resolves', async () => {
    // Required here, after the environment is set, so anything read at import
    // time sees the test values.
    const { AppModule } = await import('./app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60_000);
});
