/**
 * The one matcher (plan W3), on its own. Receipts, suppliers and the sale tool
 * all go through `matchByName`; each rule is pinned here once.
 *
 * The rule under test: only an exact normalised name, an exact SKU or the id
 * itself is "matched". Plurals, word order, punctuation and extra descriptor
 * words make a name a CANDIDATE — ranked, offered, never taken.
 */
import { matchByName, matchTokens, nameScore, singular } from './name-matching';

const products = [
  { id: 'p-pad', name: 'Honda CBR Brake Pad', sku: 'HCB-BP' },
  { id: 'p-helmet', name: 'Full Face Helmet', sku: 'FFH-01' },
  { id: 'p-plug', name: 'Spark plug', sku: null },
  { id: 'p-chain', name: 'Drive chain 428', sku: 'DC-428' },
];

const candidateIds = (r: ReturnType<typeof matchByName>) =>
  r.status === 'matched' ? [] : r.candidates.map((c) => c.item.id);

describe('matchByName — what counts as matched', () => {
  it('An exact name, ignoring case and spacing → matched without a question', () => {
    const r = matchByName({ name: '  honda   cbr BRAKE-pad ' }, products);
    expect(r).toMatchObject({
      status: 'matched',
      match: { item: { id: 'p-pad' }, via: 'name', score: 1 },
    });
  });

  it('A SKU, ignoring case, spaces and dashes → matched without a question', () => {
    const r = matchByName({ name: 'whatever', sku: 'ffh 01' }, products);
    expect(r).toMatchObject({
      status: 'matched',
      match: { item: { id: 'p-helmet' }, via: 'sku' },
    });
  });

  it('the id itself → matched', () => {
    const r = matchByName({ id: 'p-plug', name: 'p-plug' }, products);
    expect(r).toMatchObject({ status: 'matched', match: { via: 'id' } });
  });

  it('two products with the same exact name → several, never the first one found', () => {
    const r = matchByName({ name: 'Spark plug' }, [
      ...products,
      { id: 'p-plug-2', name: 'SPARK PLUG', sku: 'SP-2' },
    ]);
    expect(r.status).toBe('several');
    expect(candidateIds(r).sort()).toEqual(['p-plug', 'p-plug-2']);
  });
});

describe('matchByName — a weak match is never taken (§16)', () => {
  it('"Honda CBR brake pads (front)" → candidate "Honda CBR Brake Pad", asked (not new, not matched)', () => {
    const r = matchByName({ name: 'Honda CBR brake pads (front)' }, products);
    expect(r.status).toBe('close');
    expect(candidateIds(r)).toEqual(['p-pad']);
  });

  it('"Full face helmet, matt black, size L" → candidate "Full Face Helmet", asked, not matched', () => {
    const r = matchByName(
      { name: 'Full face helmet, matt black, size L', sku: 'FFH-L' },
      products,
    );
    expect(r.status).toBe('close');
    expect(candidateIds(r)).toEqual(['p-helmet']);
  });

  it('a plural alone is a candidate, not a match ("Spark plugs")', () => {
    expect(matchByName({ name: 'Spark plugs' }, products).status).toBe('close');
  });

  it('word order alone is a candidate, not a match ("Plug, spark")', () => {
    const r = matchByName({ name: 'Plug, spark' }, products);
    expect(r.status).toBe('close');
    expect(candidateIds(r)).toEqual(['p-plug']);
  });

  it('a misread letter is a candidate ("Sparck plug")', () => {
    expect(
      candidateIds(matchByName({ name: 'Sparck plug' }, products)),
    ).toEqual(['p-plug']);
  });

  it('a candidate never scores 1, so nothing downstream can read it as the same', () => {
    const r = matchByName({ name: 'Honda CBR brake pads (front)' }, products);
    expect(r.status === 'close' && r.candidates[0].score).toBeLessThan(1);
  });

  it('Nothing similar → unknown, no candidates', () => {
    const r = matchByName({ name: 'Chain kit 428H 132L' }, products);
    expect(r).toEqual({ status: 'unknown', candidates: [] });
  });

  it('one shared generic word is not enough ("Brake disc" does not offer a brake pad)', () => {
    expect(matchByName({ name: 'Brake disc' }, products).status).toBe(
      'unknown',
    );
  });

  it('a blank or punctuation-only name is unknown, not a match to anything', () => {
    expect(matchByName({ name: ' — ' }, products).status).toBe('unknown');
  });
});

describe('matchByName — ranking', () => {
  it('returns candidates ranked best first', () => {
    const r = matchByName({ name: 'Brake pad' }, [
      { id: 'front', name: 'Brake pad front', sku: null },
      { id: 'plain', name: 'Brake pads', sku: null },
      { id: 'rear-ceramic', name: 'Brake pad rear ceramic', sku: null },
    ]);
    expect(r.status).toBe('several');
    expect(candidateIds(r)).toEqual(['plain', 'front', 'rear-ceramic']);
  });

  it('caps the list at five', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      name: `Brake pad type ${i}`,
      sku: null,
    }));
    const r = matchByName({ name: 'Brake pad type' }, many);
    expect(candidateIds(r)).toHaveLength(5);
  });
});

describe('matchByName — suppliers use the same matcher', () => {
  const suppliers = [
    { id: 's-gz', name: 'Guangzhou Auto Parts' },
    { id: 's-auto', name: 'Auto Parts' },
  ];

  it('legal-form words are ignored for the exact name ("… Trading Co., Ltd")', () => {
    const r = matchByName(
      { name: 'Guangzhou Auto Parts Trading Co., Ltd' },
      suppliers,
      'supplier',
    );
    expect(r).toMatchObject({
      status: 'matched',
      match: { item: { id: 's-gz' } },
    });
  });

  it('a supplier name with a word missing is offered, not taken', () => {
    const r = matchByName({ name: 'Guangzhou Parts' }, suppliers, 'supplier');
    expect(r.status).not.toBe('matched');
    expect(candidateIds(r)).toContain('s-gz');
  });

  it('"Moto Parts" does not offer "Auto Parts" (one word in two is too little)', () => {
    expect(
      matchByName({ name: 'Moto Parts' }, [suppliers[1]], 'supplier').status,
    ).toBe('unknown');
  });
});

describe('the pieces', () => {
  it('singular folds the plurals a parts invoice uses', () => {
    expect(
      ['pads', 'boxes', 'batteries', 'glass', 'bus', 'kit', 'l', '132l'].map(
        singular,
      ),
    ).toEqual(['pad', 'box', 'battery', 'glass', 'bus', 'kit', 'l', '132l']);
  });

  it('matchTokens drops legal-form words only for a supplier', () => {
    expect(matchTokens('Yiwu Trading Co', 'supplier')).toEqual(['yiwu']);
    expect(matchTokens('Yiwu Trading Co')).toEqual(['yiwu', 'trading', 'co']);
  });

  it('nameScore is 0 for a pair not worth offering', () => {
    expect(nameScore('Handlebar grips', 'Spark plug')).toBe(0);
  });
});
