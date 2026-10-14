// Called by scripts/prod-reset-partners.sh, which pulls the production URL and
// reads the passwords. One transaction: either everything below happens, or
// nothing does. TRUNCATE without CASCADE, so a kept table that still points at
// an emptied one makes Postgres refuse rather than silently cascade.
const { createRequire } = require('module');
const req = createRequire(process.argv[2] + '/package.json');
const { PrismaClient } = req('@prisma/client');
const bcrypt = req('bcrypt');

const KEEP = new Set(['_prisma_migrations', 'currency_rates', 'oauth_clients']);
const AUTH = ['oauth_refresh_tokens', 'partners', 'users'];

const people = require('fs')
  .readFileSync(0, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [name, email, password] = line.split('\t');
    return { name, email: email.trim().toLowerCase(), password };
  });

const p = new PrismaClient();
(async () => {
  if (people.length === 0) throw new Error('no partners given');
  const hashed = await Promise.all(
    people.map(async (x) => ({ ...x, hash: await bcrypt.hash(x.password, 12) })),
  );

  const tables = (await p.$queryRawUnsafe(`select tablename from pg_tables where schemaname='public'`))
    .map((t) => t.tablename)
    .filter((t) => !KEEP.has(t) && !AUTH.includes(t));

  await p.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`);
      for (const t of AUTH) await tx.$executeRawUnsafe(`DELETE FROM "${t}"`);
      for (const x of hashed) {
        const user = await tx.user.create({
          data: { email: x.email, passwordHash: x.hash, role: 'CORE_PARTNER', status: 'ACTIVE' },
        });
        await tx.partner.create({ data: { userId: user.id, displayName: x.name } });
      }
    },
    { timeout: 120000 },
  );

  const left = [];
  for (const t of await p.$queryRawUnsafe(`select tablename from pg_tables where schemaname='public' order by 1`)) {
    const [{ n }] = await p.$queryRawUnsafe(`select count(*)::int n from "${t.tablename}"`);
    if (n > 0) left.push(`${t.tablename}: ${n}`);
  }
  console.log('Done. Logins: ' + hashed.map((x) => x.email).join(', '));
  console.log('Rows left:\n  ' + left.join('\n  '));
  await p.$disconnect();
})().catch(async (e) => {
  console.error('FAILED, nothing changed:', e.message);
  await p.$disconnect();
  process.exit(1);
});
