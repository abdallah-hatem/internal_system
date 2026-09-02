// Loads every compiled module the way the serverless runtime does, so an
// ERR_REQUIRE_ESM shows up here rather than as a 500 in production.
const { execSync } = require('child_process');
const files = execSync("find dist/src -name '*.js'", { encoding: 'utf8' }).trim().split('\n');
const failures = [];
for (const f of files) {
  try { require('./' + f); }
  catch (e) { if (e.code === 'ERR_REQUIRE_ESM' || e.code === 'MODULE_NOT_FOUND') failures.push(`${f}: ${e.code} — ${e.message.split('\n')[0].slice(0, 90)}`); }
}
console.log(`  checked ${files.length} compiled modules`);
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('  no ERR_REQUIRE_ESM / MODULE_NOT_FOUND');
