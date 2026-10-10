/**
 * No status, role, method, basis, type or channel code reaches the screen raw
 * (U5, UX #10). The API sends codes — `PARTIALLY_PAID`, `CORE_PARTNER`,
 * `PER_PIECE` — and `useCodeLabel` turns them into words in the reader's
 * language. A page that prints `{order.status}` shows an Arabic reader an
 * English constant, and nothing looks broken in English.
 *
 * This reads every TSX source under app/[locale] and components and fails on
 * the shapes a raw code takes:
 *
 *   {order.status}                   a code as a JSX child
 *   value={viewingPO.status}         a code handed to a display prop
 *   `…${detail.action}`              a code pasted into a sentence
 *   role.replace(/_/g, ' ')          a code "prettified" into English
 *
 * Run with `npm run test:unit`. Set U5_SCAN_ROOT to scan another checkout (how
 * this was shown to fail on the code before the sweep).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.U5_SCAN_ROOT ?? join(HERE, '../src');
const DIRS = [join(ROOT, 'app/[locale]'), join(ROOT, 'components')];

/** Property names that hold a code the API sends. */
const CODE_PROP =
  '(?:status|Status|role|Role|method|Method|channel|Channel|costBasis|basis|Basis|originType|participantType|entityType|movementType|referenceType|eventType|action|type|Type)';
// The last property *ends* in one of them: `verificationStatus`, `participantType`.
const CHAIN = `[A-Za-z_$][\\w$]*(?:\\??\\.[\\w$]+)*\\??\\.[\\w$]*${CODE_PROP}\\b`;

const RULES = [
  {
    name: 'a code as a JSX child',
    // `{x.status}` not preceded by `=` (an attribute) or `$` (a template).
    re: new RegExp(`(?<![=$\\w])\\{\\s*${CHAIN}\\s*\\}`, 'g'),
  },
  {
    name: 'a code handed to a display prop',
    re: new RegExp(`\\b(?:value|label|title|hint|text)=\\{\\s*${CHAIN}\\s*\\}`, 'g'),
  },
  {
    name: 'a code as an option label or hint',
    re: new RegExp(`\\b(?:label|hint):\\s*${CHAIN}\\s*[,}]`, 'g'),
  },
  {
    name: 'a code pasted into a sentence',
    re: new RegExp(`\\$\\{\\s*${CHAIN}\\s*\\}`, 'g'),
  },
  {
    name: 'a code prettified into English',
    re: /\.replace\(\/_\/g,\s*['"] ['"]\)/g,
  },
];

/**
 * Lines a rule may match for a reason other than display. Each is a code used
 * as data — a select's current value, a key, an id — never shown as text.
 */
const ALLOWED = [
  // Controlled inputs and selects hold the code; their options carry labels.
  /<(?:Select|select|input)\b[^>]*value=\{/,
  /^\s*value=\{/, // the value line of a multi-line <Select>
  /defaultValue=\{/,
  /\bkey=\{/,
  /data-[\w-]+=\{/,
  // A cache key or a URL, not a sentence.
  /queryKey:|`\/[\w/-]*\$\{|api\.(?:get|post|put|patch|delete)\(/,
  // RecordRefundDialog keys its choices by payer type and id (not shown).
  /const key = \(p: RefundPayer\)/,
];

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* tsxFiles(path);
    else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) yield path;
  }
}

/** Every raw render in one file's text, as "line: snippet". */
export function rawCodeRenders(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*(?:\*|\/\*)/.test(line)) return; // a comment
    if (ALLOWED.some((re) => re.test(code))) return;
    for (const rule of RULES) {
      for (const m of code.matchAll(rule.re)) found.push(`${i + 1}: ${m[0]}  (${rule.name})`);
    }
  });
  return found;
}

test('the detector flags the shapes a raw code takes, and passes a translated one', () => {
  const bad = [
    '<span>{order.status}</span>',
    '<td>{log.entityType}</td>',
    '              {po.status}',
    '<Detail label={tc("status")} value={viewingPO.status} />',
    'title={`${t("action")}: ${detail.action}`}',
    "user.role.toLowerCase().replace(/_/g, ' ')",
    '{c.originType} · {c.status}',
    '{mov?.movementType}',
    '<span>{b.verificationStatus}</span>',
    "options={customers.map((c) => ({ value: c.id, label: c.displayName, hint: c.type }))}",
  ];
  for (const sample of bad) assert.notEqual(rawCodeRenders(sample).length, 0, sample);

  const good = [
    "<span>{codeLabel('orderStatus', order.status)}</span>",
    "<Detail value={codeLabel('poStatus', viewingPO.status)} />",
    '<StatusBadge status={cycle.status} label={label} />',
    'className={`${STATUS_COLORS[po.status]}`}',
    '<Select name="type" value={form.type} onChange={setType} />',
    "{order.status === 'PAID' ? a : b}",
    'key={p.type}',
  ];
  for (const sample of good) assert.deepEqual(rawCodeRenders(sample), [], sample);
});

test('no page or component renders a code raw', () => {
  const findings = [];
  for (const dir of DIRS) {
    for (const file of tsxFiles(dir)) {
      for (const hit of rawCodeRenders(readFileSync(file, 'utf8'))) {
        findings.push(`${relative(ROOT, file)}:${hit}`);
      }
    }
  }
  assert.deepEqual(findings, [], `Use useCodeLabel() for these:\n${findings.join('\n')}`);
});
