import type { AccountFunding } from './funding-card';

/**
 * What `GET /cycles/:id/account-funding` answers, for the web tests that
 * render the Funding card. The server owns every figure; this builds a
 * plausible answer from a cycle's participants so a page test can render the
 * card without restating the server's arithmetic. A test about a figure
 * passes it in explicitly (`overrides`).
 */
export interface FixtureParticipant {
  id: string;
  participantType: string;
  contributionAmount: unknown;
  customProfitPct?: unknown;
  partner?: { email?: string; partner?: { displayName?: string } | null } | null;
  investor?: { email?: string; partner?: { displayName?: string } | null } | null;
}

const money = (n: number) => n.toFixed(2);

export function accountFundingFixture(args: {
  cycleId?: string;
  code?: string;
  status?: string;
  fundingLock?: string | null;
  participants: FixtureParticipant[];
  toFund?: number;
  overrides?: Partial<AccountFunding>;
}): AccountFunding {
  const nameOf = (p: FixtureParticipant) =>
    p.partner?.partner?.displayName ?? p.investor?.partner?.displayName ?? p.partner?.email ?? p.investor?.email ?? '';
  const core = args.participants.filter((p) => p.participantType === 'CORE_PARTNER');
  const investors = args.participants
    .filter((p) => p.participantType !== 'CORE_PARTNER')
    .reduce((s, p) => s + Number(p.contributionAmount ?? 0), 0);
  const toFund = args.toFund ?? 0;
  const base = Math.max(Math.round((toFund - investors) * 100), 0);
  const each = core.length ? Math.floor(base / core.length) : 0;
  const share = (i: number) => (i === core.length - 1 ? base - each * (core.length - 1) : each) / 100;
  const total = args.participants.reduce((s, p) => s + Number(p.contributionAmount ?? 0), 0);
  const custom = args.participants.some((p) => p.customProfitPct != null);
  return {
    cycleId: args.cycleId ?? 'c-1',
    code: args.code ?? 'CYC-1',
    status: args.status ?? 'PURCHASING',
    currency: 'EGP',
    fundingLock: args.fundingLock ?? null,
    closed: ['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(args.status ?? ''),
    target: null,
    putIn: {
      totalEgp: money(core.reduce((s, p) => s + Number(p.contributionAmount ?? 0), 0)),
      inTargetCurrency: null,
      byPartner: core.map((p) => ({
        partnerUserId: `u-${p.id}`,
        name: nameOf(p),
        totalEgp: money(Number(p.contributionAmount ?? 0)),
        inTargetCurrency: null,
        contributionEgp: money(Number(p.contributionAmount ?? 0)),
        enteredEgp: money(Number(p.contributionAmount ?? 0)),
        fromAccountEgp: '0.00',
        undrawnAdvancesEgp: '0.00',
        advances: [],
      })),
    },
    friends: null,
    paidSoFar: { totalEgp: '0.00', inTargetCurrency: null, byPartner: [] },
    partners: core.map((p, i) => {
      const still = Math.max(share(i) - Number(p.contributionAmount ?? 0), 0);
      return {
        partnerUserId: `u-${p.id}`,
        participantId: p.id,
        name: nameOf(p),
        shareEgp: money(share(i)),
        stillToGiveEgp: money(still),
        coverEgp: money(-still),
        availableEgp: '0.00',
        ownAdvancesEgp: '0.00',
        untiedEgp: '0.00',
        elsewhereEgp: '0.00',
        balanceEgp: '0.00',
        contributionEgp: money(Number(p.contributionAmount ?? 0)),
        fromAccountEgp: '0.00',
      };
    }),
    toFundEgp: money(toFund),
    investorsEgp: money(investors),
    partnersContributedEgp: money(total - investors),
    stillToContributeEgp: money(Math.max(toFund - total, 0)),
    shares: { basis: 'COST_TO_FUND', ofEgp: money(toFund), partnersEgp: money(base / 100), stillEgp: money(Math.max(base / 100 - (total - investors), 0)) },
    participants: args.participants.map((p) => ({
      participantId: p.id,
      participantType: p.participantType,
      name: nameOf(p),
      contributionEgp: money(Number(p.contributionAmount ?? 0)),
      customProfitPct: p.customProfitPct == null ? null : money(Number(p.customProfitPct)),
      investorFeePct: null,
      profitPct: custom
        ? p.customProfitPct == null ? null : money(Number(p.customProfitPct))
        : total > 0 ? money((Number(p.contributionAmount ?? 0) / total) * 100) : null,
    })),
    profitSplit: {
      basis: custom ? 'CUSTOM_SPLIT' : total > 0 ? 'CONTRIBUTIONS' : 'NONE',
      equal: !custom && total > 0 && args.participants.every((p) => Number(p.contributionAmount) === Number(args.participants[0].contributionAmount)),
      problem: null,
    },
    ...args.overrides,
  };
}
