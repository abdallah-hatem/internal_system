'use client';
import { useAllRecords } from '@/lib/list-all';
import { Select } from '../ui/select';
import { DatePicker } from '../ui/date-picker';
import { useCurrencyRates } from '../../lib/currency-rates';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShippingCostFields, readShippingCostFields } from '../shipping/ShippingCostFields';
import { api } from '../../lib/api';
import { useToast } from '../ui/toast';
import { selectOnFocus } from '../../lib/select-on-focus';
import { MoneyInput } from '../ui/money-input';
import { Money } from '../ui/money';
import { businessToday, useDateFormat } from '../../lib/dates';
import { useCodeLabel } from '../../lib/labels';
import { statusesToWalk, WIZARD_STATUSES } from './wizard-walk';
import {
  useCycleWizardDraft,
  draftIsWorthKeeping,
  emptyLineItem,
  type CycleWizardDraft,
  type WizardLineItem,
} from '../../stores/cycle-wizard-draft';
import {
  Route,
  ShoppingCart,
  Truck,
  Wallet,
  CheckCircle2,
  Plus,
  X,
  ArrowLeft,
  Loader2,
} from 'lucide-react';

import { useApiError } from '../../lib/api-error';
import { FieldWithQuickCreate } from '../ui/quick-create';
import { ValidatedForm } from '@/components/ui/validated-form';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Four steps, and the last is the money. Receiving used to be step 4 and it
 * could only be reached once every leg had arrived — so a cycle set up on the
 * day it was ordered dead-ended there. Receiving now happens on the cycle page,
 * one delivery at a time (spec 2026-10-10, UX #5).
 */
const STEPS = [
  { titleKey: 'step1Title', icon: Route },
  { titleKey: 'step2Title', icon: ShoppingCart },
  { titleKey: 'step3Title', icon: Truck },
  { titleKey: 'step4Title', icon: Wallet },
] as const;

/** The step the wizard ends on. */
const LAST_STEP = STEPS.length - 1;

/** The fields one shipping leg's cost block posts, without the leg prefix. */
const COST_FIELDS = [
  'costBasis',
  'ratePerUnit',
  'chargeablePieces',
  'chargeableWeightKg',
  'amount',
  'currency',
  'fxRateToEgp',
] as const;

/** An FX rate as the order form shows it: four places, or blank. */
const formatRate = (v: unknown) => {
  if (v === '' || v == null) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : '';
};

/** Every named value in a form, as strings. */
function readForm(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((value, key) => {
    if (typeof value === 'string') out[key] = value;
  });
  return out;
}

type LineItem = WizardLineItem;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CycleWizard({ existingCycleId }: { existingCycleId?: string }) {
  const apiError = useApiError();
  const router = useRouter();
  const queryClient = useQueryClient();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();

  /**
   * Drop the cached cycle lists.
   *
   * The wizard writes cycles but never told the cache, so leaving it landed
   * on a list still showing the state from before — the change was saved and
   * invisible until a manual refresh.
   */
  const refreshCycleCaches = () => {
    void queryClient.invalidateQueries({ queryKey: ['cycles'] });
    void queryClient.invalidateQueries({ queryKey: ['cycle'] });
  };
  const locale = useLocale();
  const t = useTranslations('wizard');
  const tc = useTranslations('common');
  const toast = useToast();

  // Wizard state
  const [currentStep, setCurrentStep] = useState(0);
  const [cycleId, setCycleId] = useState<string | null>(existingCycleId ?? null);
  const [cycleCode, setCycleCode] = useState<string | null>(null);
  const [originType, setOriginType] = useState<string>('');
  const [poId, setPoId] = useState<string | null>(null);
  const [poReference, setPoReference] = useState<string | null>(null);

  // Step 2 — the order starts with one row to fill in.
  const [lineItems, setLineItems] = useState<LineItem[]>(() => [emptyLineItem()]);

  // Step 2 form state. Held here, not in the inputs, so stepping back and
  // forward keeps what was typed.
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poCurrency, setPoCurrency] = useState('');
  const [poFxRate, setPoFxRate] = useState('');
  const rates = useCurrencyRates();
  // Which saved leg each sequence maps to, so a second pass through step 3
  // updates the legs instead of trying to create them again.
  const [legIds, setLegIds] = useState<Record<number, string>>({});

  // Blank means "today in Cairo" — the default the picker shows. Kept blank
  // rather than filled so an untouched wizard still counts as untouched.
  const [poOrderedOn, setPoOrderedOn] = useState('');

  const [isCreatingLegs, setIsCreatingLegs] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  // Track the furthest step reached so step buttons allow both forward and backward navigation
  const [maxStepReached, setMaxStepReached] = useState(0);

  // Resume loading state
  const [isResuming, setIsResuming] = useState(!!existingCycleId);

  // Track the furthest step reached so the progress bar allows forward+backward navigation
  useEffect(() => {
    setMaxStepReached((prev) => Math.max(prev, currentStep));
  }, [currentStep]);

  // ---------------------------------------------------------------------------
  // Draft persistence (new cycles only)
  // ---------------------------------------------------------------------------

  /**
   * Resuming an existing cycle loads that cycle from the server, and the server
   * is the truth for it. Only the /cycles/new flow has state that exists
   * nowhere else, so only that flow keeps a draft.
   */
  const isNewWizard = !existingCycleId;
  const draftHydrated = useCycleWizardDraft((s) => s.hydrated);
  const storedDraft = useCycleWizardDraft((s) => s.draft);
  const saveDraft = useCycleWizardDraft((s) => s.save);
  const clearDraft = useCycleWizardDraft((s) => s.clear);
  const saveLegFields = useCycleWizardDraft((s) => s.saveLegFields);
  const clearLegFields = useCycleWizardDraft((s) => s.clearLegFields);
  const unsavedLegs = useCycleWizardDraft((s) =>
    cycleId ? s.legFields[cycleId]?.fields : undefined,
  );
  const draftRestoredRef = useRef(false);
  // Whether this session opened onto restored work, so the wizard can say so.
  const [showRestoredNotice, setShowRestoredNotice] = useState(false);

  const currentDraft: CycleWizardDraft = {
    currentStep,
    maxStepReached,
    cycleId,
    cycleCode,
    poId,
    poReference,
    legIds,
    originType,
    poSupplierId,
    poCurrency,
    poFxRate,
    poOrderedOn,
    lineItems,
  };

  const forgetDraft = () => {
    // Mark restored too: a cleared draft must not be restored a second time by
    // the effect below, which would put back what was just discarded.
    draftRestoredRef.current = true;
    setShowRestoredNotice(false);
    clearDraft();
  };

  // Put a saved draft back, once, as soon as localStorage has been read.
  useEffect(() => {
    if (!isNewWizard || !draftHydrated || draftRestoredRef.current) return;
    draftRestoredRef.current = true;

    const draft = storedDraft;
    if (!draftIsWorthKeeping(draft) || !draft) return;

    /**
     * A draft outlives the records it points at.
     *
     * It survives a database reset, a cycle someone else deleted, and a switch
     * between environments — and then restores ids for rows that no longer
     * exist. The wizard came back on step 3 holding a leg id from the old
     * database, and saving tried to UPDATE that leg: "Shipping leg not found",
     * on a step the person had not touched yet and with no way to get past it.
     *
     * So the cycle is confirmed to still exist before any of it is applied.
     * If it has gone, the draft is worthless — there is nothing to resume.
     */
    const apply = () => {
      setShowRestoredNotice(true);
      // A draft written by the old four-step wizard may stand on the success
      // screen (step 4), which no longer exists; the money step is the last.
      setCurrentStep(Math.min(draft.currentStep, LAST_STEP));
      setMaxStepReached(Math.min(draft.maxStepReached ?? 0, LAST_STEP));
      setCycleId(draft.cycleId);
      setCycleCode(draft.cycleCode);
      setPoId(draft.poId);
      setPoReference(draft.poReference);
      setLegIds(draft.legIds ?? {});
      setOriginType(draft.originType);
      setPoSupplierId(draft.poSupplierId);
      setPoCurrency(draft.poCurrency);
      setPoFxRate(draft.poFxRate);
      setPoOrderedOn(draft.poOrderedOn);
      setLineItems(draft.lineItems.length > 0 ? draft.lineItems : [emptyLineItem()]);
    };

    // Nothing saved server-side yet: there is nothing to go stale.
    if (!draft.cycleId) {
      apply();
      return;
    }

    let cancelled = false;
    api
      .get(`/cycles/${draft.cycleId}`)
      .then(() => {
        if (!cancelled) apply();
      })
      .catch(() => {
        // The cycle is gone. Drop the draft rather than restoring a wizard
        // that cannot save anything.
        if (!cancelled) forgetDraft();
      });
    return () => {
      cancelled = true;
      // Not restored after all: the check was abandoned before it answered.
      // React's development mode mounts every effect twice — run, clean up,
      // run — and with the ref left set, the second run returned early, so the
      // draft was never put back and a reload landed on an empty step 1.
      draftRestoredRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per hydrated draft; forgetDraft is stable in effect
  }, [isNewWizard, draftHydrated, storedDraft]);

  // Keep the saved draft in step with the form.
  //
  // Waits for the restore above: saving first would write the wizard's empty
  // initial state over the draft it is about to read.
  useEffect(() => {
    if (!isNewWizard || !draftHydrated || !draftRestoredRef.current) return;
    if (!draftIsWorthKeeping(currentDraft)) return;
    saveDraft(currentDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentDraft is rebuilt every render; its fields are listed
  }, [
    isNewWizard,
    draftHydrated,
    currentStep,
    maxStepReached,
    cycleId,
    cycleCode,
    poId,
    poReference,
    legIds,
    originType,
    poSupplierId,
    poCurrency,
    poFxRate,
    poOrderedOn,
    lineItems,
  ]);

  // ---------------------------------------------------------------------------
  // The cycle as the server holds it
  // ---------------------------------------------------------------------------

  /**
   * Read for a new cycle too, once step 1 has created it: the orders and legs
   * it already has are what steps 2 and 3 show, whichever way the wizard was
   * opened.
   */
  const {
    data: cycle,
    isLoading: isLoadingCycle,
    refetch: refetchCycle,
  } = useQuery({
    queryKey: ['cycle', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId,
  });

  /** Every order on the cycle — a resumed cycle can hold more than one. */
  const savedOrders: any[] = Array.isArray(cycle?.purchaseOrders) ? cycle.purchaseOrders : [];

  /**
   * Who is funding this cycle, and for how much.
   *
   * The wizard never asked. Contributions are seeded at zero because the cost
   * is not known when the cycle is created, and filling them in lived on a
   * different page entirely — so it was a step you could simply forget, weeks
   * before settlement made that matter. It matters a great deal: an unfunded
   * cycle used to hand its entire profit to whichever partner was created last.
   *
   * Asked here, on the last step, because this is where the cycle's real cost
   * is finally known: goods from step 2 plus shipping from step 3.
   */
  const participants: any[] = Array.isArray(cycle?.participants) ? cycle.participants : [];

  /**
   * What to call a participant.
   *
   * `partner` and `investor` on a participant row are USER records, and the
   * display name hangs off the Partner record nested inside each. Reading
   * `p.partner.displayName` is one level too high, so every row rendered as a
   * dash — three identical amounts against three blank names.
   */
  const participantName = (p: any) => {
    const user = p.partner ?? p.investor;
    return user?.partner?.displayName ?? user?.email ?? '—';
  };
  const [contributions, setContributions] = useState<Record<string, string>>({});
  const [isFunding, setIsFunding] = useState(false);

  // Seed the inputs from what is already recorded, once the participants load.
  useEffect(() => {
    if (participants.length === 0) return;
    setContributions((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      return Object.fromEntries(
        participants.map((p: any) => {
          const amount = Number(p.contributionAmount);
          return [p.id, amount ? amount.toFixed(2) : ''];
        }),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeded once, when the participants first arrive
  }, [participants.length]);

  // What the cycle has actually cost: goods from step 2 plus shipping from
  // step 3, which is the number the partners are funding.
  const { data: landedCost } = useQuery({
    queryKey: ['costing', cycleId],
    queryFn: () =>
      api.get(`/costing/cycles/${cycleId}/landed-cost`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId && currentStep === LAST_STEP,
  });

  /**
   * Everyone who could still be put on this cycle.
   *
   * A temporary investor is an ordinary user given money in one cycle, so the
   * list is everybody not already a participant — not only users whose role
   * says TEMP_INVESTOR. A core partner backing a cycle separately is a real
   * case, and the demo data has one.
   */
  const { items: allUsers } = useAllRecords(['users'], '/users', undefined, {
    enabled: !!cycleId && currentStep === LAST_STEP,
  });

  const onCycle = new Set(
    participants.flatMap((p: any) => [p.partnerUserId, p.investorUserId].filter(Boolean)),
  );
  const addableUsers = (Array.isArray(allUsers) ? allUsers : []).filter(
    (u: any) => !onCycle.has(u.id),
  );

  const [investorUserId, setInvestorUserId] = useState('');
  const [investorAmount, setInvestorAmount] = useState('');
  const [investorFee, setInvestorFee] = useState('');
  const [isAddingInvestor, setIsAddingInvestor] = useState(false);

  const addInvestor = async () => {
    if (!investorUserId) return;
    setIsAddingInvestor(true);
    try {
      await api.post(`/cycles/${cycleId}/participants`, {
        participantType: 'TEMP_INVESTOR',
        investorUserId,
        contributionAmount: Number(investorAmount || 0),
        investorFeePct: investorFee ? Number(investorFee) : undefined,
      });
      setInvestorUserId('');
      setInvestorAmount('');
      setInvestorFee('');
      await refetchCycle();
      refreshCycleCaches();
      toast.success(t('investorAdded'));
    } catch (err: any) {
      toast.error(apiError(err, t('investorFailed')));
    } finally {
      setIsAddingInvestor(false);
    }
  };

  const landedTotal = Number(landedCost?.totals?.landedEgp ?? 0);
  const fundedTotal = participants.reduce(
    (sum: number, p: any) => sum + Number(contributions[p.id] || 0),
    0,
  );

  /**
   * Split what the cycle actually cost across the core partners.
   *
   * To the piastre: thirds of 75,645.50 do not divide evenly, so the last
   * partner absorbs the residual and the parts re-sum exactly. Left uneven,
   * capital returned at settlement would not match capital put in.
   *
   * Investors are left alone — they put in a specific amount that is theirs,
   * not a share of the whole.
   */
  const splitEqually = () => {
    const core = participants.filter((p: any) => p.participantType === 'CORE_PARTNER');
    if (core.length === 0) return;
    const investors = participants
      .filter((p: any) => p.participantType !== 'CORE_PARTNER')
      .reduce((sum: number, p: any) => sum + Number(contributions[p.id] || 0), 0);

    const cents = Math.round(Math.max(landedTotal - investors, 0) * 100);
    const each = Math.floor(cents / core.length);
    const next: Record<string, string> = { ...contributions };
    core.forEach((p: any, i: number) => {
      const amount = (i === core.length - 1 ? cents - each * (core.length - 1) : each) / 100;
      next[p.id] = amount.toFixed(2);
    });
    setContributions(next);
  };

  /** Write every contribution that differs from what is recorded. */
  const writeContributions = async () => {
    for (const p of participants) {
      const next = Number(contributions[p.id] || 0);
      if (next === Number(p.contributionAmount)) continue;
      await api.put(`/cycles/participants/${p.id}`, { contributionAmount: next });
    }
  };

  const saveFunding = async () => {
    setIsFunding(true);
    try {
      await writeContributions();
      await refetchCycle();
      refreshCycleCaches();
      toast.success(t('fundingSaved'));
    } catch (err: any) {
      toast.error(apiError(err, t('fundingFailed')));
    } finally {
      setIsFunding(false);
    }
  };

  // The currency the purchase order step is showing: the one already chosen on
  // this order, or failing that the cycle's own.
  const effectivePoCurrency = poCurrency || cycle?.currency || '';

  // Fill in the rate for a currency that is already selected. Resuming a cycle
  // set to AED preselected the currency but left the rate blank, because the
  // rate was only ever filled by the act of changing the currency — so the one
  // case where nothing needs changing was the case it did not cover. A rate
  // already on the order is left alone.
  useEffect(() => {
    if (!effectivePoCurrency || effectivePoCurrency === 'EGP') return;
    const known = rates[effectivePoCurrency];
    if (known == null) return;
    setPoFxRate((prev) => (prev ? prev : formatRate(known)));
  }, [effectivePoCurrency, rates]);

  /**
   * Where a resumed cycle opens.
   *
   * Decided from everything the cycle holds — every order and every leg, not
   * the first of each. A cycle past the wizard's reach (being received, sold
   * or settled) opens on its own page instead: there is nothing left here for
   * it, and the old success screen only said so after a click.
   */
  useEffect(() => {
    if (!cycle || !isResuming) return;

    if (!WIZARD_STATUSES.includes(cycle.status)) {
      router.replace(`/${locale}/cycles/${cycle.id}/details`);
      return;
    }

    setCycleCode(cycle.code);
    setOriginType(cycle.originType ?? '');

    const orders: any[] = cycle.purchaseOrders ?? [];
    const legs: any[] = cycle.shippingLegs ?? [];
    if (orders.length > 0) {
      setPoId(orders[0].id);
      setPoReference(orders[0].reference);
    }
    setLegIds(Object.fromEntries(legs.map((l: any) => [l.sequence, l.id])));

    const step = orders.length === 0 ? 1 : legs.length === 0 ? 2 : LAST_STEP;
    setCurrentStep(step);
    setMaxStepReached(step);
    setIsResuming(false);
  }, [cycle, isResuming, locale, router]);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const { items: suppliers } = useAllRecords(['suppliers'], '/suppliers', undefined, {
    enabled: currentStep >= 1,
  });
  const { items: products } = useAllRecords(['products'], '/products', undefined, {
    enabled: currentStep >= 1,
  });

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
    enabled: currentStep === 2,
  });

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const createCycleMutation = useMutation({
    mutationFn: (data: any) => api.post('/cycles', data),
    onSuccess: (res) => {
      const result = res.data.data ?? res.data;
      setCycleId(result.id);
      setCycleCode(result.code);
      setCurrentStep(1);
      refreshCycleCaches();
      toast.success(t('cycleCreated'));
    },
    onError: (err: any) => {
      toast.error(apiError(err, t('createCycleFailed')));
    },
  });

  const createPoMutation = useMutation({
    mutationFn: (data: any) => api.post(`/cycles/${cycleId}/purchases`, data),
    onSuccess: (res) => {
      const result = res.data.data ?? res.data;
      setPoId(result.id);
      setPoReference(result.reference);
      setCurrentStep(2);
      refreshCycleCaches();
      // Step 2 shows the saved order from here on, and step 3 seeds its piece
      // counts from it.
      void refetchCycle();
      toast.success(t('purchaseCreated'));
    },
    onError: (err: any) => {
      toast.error(apiError(err, t('createPurchaseFailed')));
    },
  });

  // ---------------------------------------------------------------------------
  // Step handlers
  // ---------------------------------------------------------------------------

  const handleStep1Submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setOriginType(fd.get('originType') as string);

    // If cycle already exists (navigating back from step 2+), just advance
    if (cycleId) {
      setCurrentStep(1);
      return;
    }

    // No start date is asked for: a cycle starts when it is set up, and the
    // API dates it today when the field is omitted. Leaving it blank was
    // already what nearly every cycle did.
    createCycleMutation.mutate({
      originType: fd.get('originType'),
      currency: fd.get('currency'),
    });
  };

  const handleStep2Submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    // The order was saved a moment ago and the list of orders has not caught
    // up yet: there is nothing new to create.
    if (poId) {
      setCurrentStep(2);
      return;
    }

    // Require at least one line item
    if (lineItems.length === 0) {
      toast.error(t('addAtLeastOneItem'));
      return;
    }

    createPoMutation.mutate({
      supplierId: fd.get('supplierId'),
      currency: fd.get('currency'),
      fxRateToEgp: Number(fd.get('fxRateToEgp')),
      orderedOn: fd.get('orderedOn'),
      items: lineItems,
    });
  };

  // A China cycle moves in two legs (China->UAE, then UAE->Egypt); a UAE-direct
  // cycle has only the UAE->Egypt leg. Each leg carries its own cost.
  const legPlan =
    originType === 'UAE_DIRECT'
      ? [{ sequence: 1, label: t('legUaeToEgypt'), origin: 'Dubai, UAE', destination: 'Cairo, Egypt' }]
      : [
          { sequence: 1, label: t('legChinaToUae'), origin: 'Guangzhou, CN', destination: 'Dubai, UAE' },
          { sequence: 2, label: t('legUaeToEgypt'), origin: 'Dubai, UAE', destination: 'Cairo, Egypt' },
        ];

  // What the cycle actually bought, used to prefill each leg's piece count:
  // every saved order's lines, or the lines being typed before there is one.
  const savedPieces = savedOrders.reduce(
    (sum: number, po: any) =>
      sum +
      (po.items ?? []).reduce((s: number, item: any) => s + Number(item.orderedQty || 0), 0),
    0,
  );
  const orderedPieces =
    savedPieces > 0
      ? savedPieces
      : lineItems.reduce((sum, item) => sum + Number(item.orderedQty || 0), 0);

  // ---------------------------------------------------------------------------
  // Step 3 — what was typed and not saved survives leaving the step
  // ---------------------------------------------------------------------------

  /**
   * The leg form is uncontrolled: its fields, and the cost block's own state,
   * read their starting values once. So going back to the order, or out to the
   * list and in again, used to drop everything typed here.
   *
   * After each interaction the form is read and whatever differs from what it
   * opened with is kept in the draft store for this cycle; the next visit
   * starts from that. Saving the legs clears it.
   */
  const legFormRef = useRef<HTMLFormElement | null>(null);
  const legBaselineRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (currentStep !== 2) {
      legBaselineRef.current = null;
      return;
    }
    // After the children have rendered their hidden inputs.
    const id = window.setTimeout(() => {
      if (legFormRef.current) legBaselineRef.current = readForm(legFormRef.current);
    }, 0);
    return () => window.clearTimeout(id);
  }, [currentStep]);

  const rememberLegFields = () => {
    if (!cycleId) return;
    // A tick later: a date or option picked by click lands in its hidden input
    // on the render after the event.
    window.setTimeout(() => {
      const form = legFormRef.current;
      const baseline = legBaselineRef.current;
      if (!form || !baseline) return;
      const now = readForm(form);
      const before = useCycleWizardDraft.getState().legFields[cycleId]?.fields ?? {};
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(now)) {
        if (value !== baseline[name] || name in before) kept[name] = value;
      }
      saveLegFields(cycleId, kept);
    }, 0);
  };

  const typedLeg = (name: string): string | undefined => unsavedLegs?.[name];

  const legCostDefaults = (prefix: string, existing: any) => {
    const saved = existing
      ? {
          costBasis: existing.costBasis ?? 'PER_PIECE',
          ratePerUnit: existing.ratePerUnit ?? '',
          chargeablePieces: existing.chargeablePieces ?? '',
          chargeableWeightKg: existing.chargeableWeightKg ?? '',
          amount: existing.amount ?? '',
          currency: existing.currency ?? 'EGP',
          fxRateToEgp: existing.fxRateToEgp ?? 1,
        }
      : undefined;
    const typed = Object.fromEntries(
      COST_FIELDS.filter((k) => typedLeg(`${prefix}${k}`) !== undefined).map((k) => [
        k,
        typedLeg(`${prefix}${k}`),
      ]),
    );
    if (!saved && Object.keys(typed).length === 0) return undefined;
    return { ...(saved ?? {}), ...typed };
  };

  const handleStep3Submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const payloads = legPlan.map((leg) => {
      const prefix = `leg${leg.sequence}_`;
      const str = (k: string) => String(fd.get(`${prefix}${k}`) || '');
      return {
        sequence: leg.sequence,
        origin: str('origin'),
        destination: str('destination'),
        // Both: the id is the link, the name is what the leg displays. Only
        // the name was sent before, so provider_id was null on every leg the
        // wizard made — a provider's shipments could not be found from the
        // provider, and the delete guard counts through exactly that relation,
        // so it called every provider unused and let them be deleted.
        // `name:<x>` is the leg's own unlinked provider offered back to it, so
        // it carries no id — sending it as one would be a foreign key that
        // does not exist.
        providerId: str('providerId').startsWith('name:') ? undefined : str('providerId') || undefined,
        provider: str('providerId').startsWith('name:')
          ? str('providerId').slice(5)
          : providerList.find((pr: any) => pr.id === str('providerId'))?.name,
        trackingRef: str('trackingRef') || undefined,
        departedOn: str('departedOn') || undefined,
        // An arrival date is turned into a delivery of everything still on the
        // way by the server (B2); it is not a status this form sets.
        arrivedOn: str('arrivedOn') || undefined,
        ...readShippingCostFields(fd, prefix),
      };
    });

    setIsCreatingLegs(true);
    try {
      const savedIds: Record<number, string> = {};
      let updated = false;

      for (const body of payloads) {
        // A leg already saved for this sequence is edited, not recreated.
        // Returning early here instead — which is what this did — threw away
        // every change made on a second visit: dates, provider, costs, all of
        // it, with a success step and no warning.
        const existingId =
          legIds[body.sequence] ??
          cycle?.shippingLegs?.find((l: any) => l.sequence === body.sequence)?.id;

        // `sequence` identifies the leg and is uniquely constrained, so an
        // update must not carry it — the endpoint rejects it outright.
        const { sequence: _sequence, ...updatable } = body;
        void _sequence;

        // An id can outlive the leg — a restored draft, or someone deleting it
        // in another tab. Falling back to creating is better than refusing to
        // save: the person wanted this leg recorded, and it is not there.
        let res;
        let wasUpdate = Boolean(existingId);
        if (existingId) {
          try {
            res = await api.put(`/shipping/legs/${existingId}`, updatable);
          } catch (err: any) {
            if (err?.response?.status !== 404) throw err;
            wasUpdate = false;
            res = await api.post(`/cycles/${cycleId}/shipping-legs`, body);
          }
        } else {
          res = await api.post(`/cycles/${cycleId}/shipping-legs`, body);
        }

        if (wasUpdate) updated = true;
        const saved = res.data.data ?? res.data;
        savedIds[body.sequence] = saved.id ?? existingId;
      }

      setLegIds((prev) => ({ ...prev, ...savedIds }));
      // Saved: nothing typed here is unsaved any more.
      if (cycleId) clearLegFields(cycleId);
      refreshCycleCaches();
      // The cycle query holds the legs the form reads back; without this the
      // next visit would show what was on screen before this save.
      await refetchCycle();
      toast.success(
        updated
          ? t('legsUpdated', { count: payloads.length })
          : t('legsCreated', { count: payloads.length }),
      );
      setCurrentStep(LAST_STEP);
    } catch (err: any) {
      toast.error(apiError(err, t('saveShippingLegsFailed')));
    } finally {
      setIsCreatingLegs(false);
    }
  };

  /**
   * Finish: save the money, move the cycle as far as its dates allow, and open
   * the cycle's page.
   *
   * No dates → it stays PURCHASING with its order a draft (§15). A departure →
   * In transit, which confirms the order. Arrival dates already became
   * deliveries when the legs were saved, so the walk reaches Arrived UAE /
   * Arrived Egypt only when the server's gates say the goods got there — and
   * never past Arrived Egypt: receiving is the cycle page's job.
   */
  const handleFinish = async () => {
    if (!cycleId || isFinishing) return;
    setIsFinishing(true);
    try {
      // Typed and not saved is still meant: finishing does not discard it.
      await writeContributions();

      const fresh = await api.get(`/cycles/${cycleId}`).then((r) => r.data.data ?? r.data);
      let status: string = fresh.status;
      for (const next of statusesToWalk(fresh.originType, fresh.status, fresh.shippingLegs ?? [])) {
        await api.post(`/cycles/${cycleId}/transition`, { status: next });
        status = next;
      }

      refreshCycleCaches();
      clearLegFields(cycleId);
      if (isNewWizard) forgetDraft();
      toast.success(t('finished', { status: codeLabel('cycleStatus', status) }));
      router.push(`/${locale}/cycles/${cycleId}/details`);
    } catch (err: any) {
      refreshCycleCaches();
      void refetchCycle();
      toast.error(apiError(err, t('finishFailed')));
      setIsFinishing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Line item helpers (Step 2)
  // ---------------------------------------------------------------------------

  const addLineItem = () => {
    setLineItems((prev) => [...prev, emptyLineItem()]);
  };

  const updateLineItem = (idx: number, field: keyof LineItem, value: any) => {
    setLineItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    );
  };

  const removeLineItem = (idx: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const handleStartAnother = () => {
    forgetDraft();
    setCurrentStep(0);
    // `originType` and `maxStepReached` were the two fields this reset forgot,
    // and `draftIsWorthKeeping` returns true on `originType` alone — so the
    // save effect below, which fires on any of these, wrote the draft straight
    // back after it had just been discarded. "Start over" has to leave nothing
    // that counts as a draft, or it is a button that appears to work.
    setOriginType('');
    setMaxStepReached(0);
    setCycleId(null);
    setCycleCode(null);
    setPoId(null);
    setPoReference(null);
    setLegIds({});
    setLineItems([emptyLineItem()]);
    setPoSupplierId('');
    setPoCurrency('');
    setPoFxRate('');
    setPoOrderedOn('');
  };

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const supplierList: any[] = Array.isArray(suppliers) ? suppliers : [];
  const providerList: any[] = Array.isArray(providers) ? providers : [];

  // Per leg, keyed by the field prefix, so a provider created from inside one
  // leg's form does not land on the other leg of a China cycle.
  const [legProviderIds, setLegProviderIds] = useState<Record<string, string>>({});
  const setLegProviderId = (prefix: string, id: string) =>
    setLegProviderIds((prev) => ({ ...prev, [prefix]: id }));

  /**
   * The providers to choose from, plus whatever this leg already says.
   *
   * A leg saved before the pickers carried ids knows only a provider NAME, and
   * that name need not match any provider record — legs were created with free
   * text for a long time. Offering only real providers left the required field
   * empty for those legs, so the browser silently refused to submit and the leg
   * could no longer be edited at all: dates, costs, tracking, none of it.
   *
   * The stray name is offered back as `name:<whatever>`, which resolves to no
   * provider id — the leg keeps displaying what it always did, and picking a
   * real provider from the list links it properly.
   */
  const providerOptions = (current?: string) => {
    const options = providerList.map((pr: any) => ({
      value: pr.id,
      label: pr.name,
      hint: pr.contactPerson ?? undefined,
    }));
    if (current && !providerList.some((pr: any) => pr.name === current)) {
      options.unshift({ value: `name:${current}`, label: current, hint: undefined });
    }
    return options;
  };
  const productList: any[] = Array.isArray(products) ? products : [];

  const isStep1Loading = createCycleMutation.isPending;
  const isStep2Loading = createPoMutation.isPending;
  const isStep3Loading = isCreatingLegs;

  // ---------------------------------------------------------------------------
  // Loading state for resume
  // ---------------------------------------------------------------------------

  const leavingForCyclePage =
    isResuming && !!cycle && !WIZARD_STATUSES.includes(cycle.status);
  if ((isResuming && isLoadingCycle) || leavingForCyclePage) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary-600 me-3" />
        <span className="text-gray-500 text-sm">{t('loadingCycle')}</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Wizard
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Restored draft.

          Reopening onto a half-filled form with no explanation reads as a bug,
          and there has to be a way out that isn't "clear it by hand". */}
      {showRestoredNotice && (
        <div
          data-testid="wizard-draft-restored"
          className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm text-amber-900">
            {t('draftRestored')}
          </p>
          <button
            type="button"
            onClick={() => {
              forgetDraft();
              handleStartAnother();
            }}
            className="shrink-0 text-sm font-medium text-amber-900 underline hover:no-underline"
          >
            {t('draftDiscard')}
          </button>
        </div>
      )}

      {/* Progress Bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between relative">
          {/* Connector line (background) */}
          <div className="absolute top-5 start-0 end-0 h-0.5 bg-gray-200 z-0" />

          {STEPS.map((step, idx) => {
            const isCompleted = idx < currentStep;
            const isCurrent = idx === currentStep;
            const isClickable = idx <= maxStepReached;

            return (
              <button
                key={idx}
                type="button"
                onClick={() => isClickable && setCurrentStep(idx)}
                disabled={!isClickable}
                className={`relative z-10 flex flex-col items-center gap-2 ${
                  isClickable ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <div
                  className={`h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                    isCompleted
                      ? 'bg-green-500 text-white'
                      : isCurrent
                        ? 'bg-primary-600 text-white ring-4 ring-primary-100'
                        : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : (
                    idx + 1
                  )}
                </div>
                <span
                  className={`text-xs font-medium whitespace-nowrap ${
                    isCurrent ? 'text-primary-600' : isCompleted ? 'text-green-600' : 'text-gray-400'
                  }`}
                >
                  {t(step.titleKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step Content */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        {/* Step 1 — Cycle Info */}
        {currentStep === 0 && (
          <ValidatedForm onSubmit={handleStep1Submit} className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('cycleInformation')}</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('originType')} <span className="text-red-500">*</span>
              </label>
              <Select
                name="originType"
                required
                value={originType || cycle?.originType || ''}
                onChange={setOriginType}
                placeholder={t('selectOriginType')}
                options={[
                  { value: 'CHINA', label: t('china') },
                  { value: 'UAE_DIRECT', label: t('uaeDirect') },
                ]}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('currency')} <span className="text-red-500">*</span>
              </label>
              <Select
                name="currency"
                required
                value={effectivePoCurrency}
                onChange={setPoCurrency}
                placeholder={t('selectCurrency')}
                options={[
                  { value: 'CNY', label: 'CNY (¥)' },
                  { value: 'AED', label: 'AED' },
                  { value: 'USD', label: 'USD ($)' },
                ].map((o) => ({
                  ...o,
                  hint: rates[o.value] != null ? `${rates[o.value]} EGP` : t('noRateSet'),
                }))}
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={isStep1Loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep1Loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('saveAndContinueBtn')}
              </button>
            </div>
          </ValidatedForm>
        )}

        {/* Step 2 — the orders already on the cycle.

            Every one of them, not the first. They are saved records, so they
            are shown as they are rather than offered as a form whose edits the
            wizard would then quietly not send. */}
        {currentStep === 1 && savedOrders.length > 0 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('purchaseOrder')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('savedOrdersHint')}</p>
            </div>

            <div className="space-y-3">
              {savedOrders.map((po: any) => (
                <div
                  key={po.id}
                  data-testid="wizard-saved-order"
                  className="space-y-2 rounded-xl border border-border p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {po.reference}
                    </span>
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                      {codeLabel('orderStatus', po.status)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {po.supplier?.name ?? '—'} · {formatDate(po.orderedOn)}
                  </p>
                  <ul className="divide-y divide-border">
                    {(po.items ?? []).map((item: any) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm"
                      >
                        <span className="min-w-0 break-words text-foreground">
                          {item.product?.name ?? '—'}
                        </span>
                        <span className="text-muted-foreground">
                          {t('orderLine', { qty: Number(item.orderedQty) })}{' '}
                          <Money value={item.unitPrice} currency={po.currency} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(0)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('back')}
              </button>
              <button
                type="button"
                onClick={() => setCurrentStep(2)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
              >
                {t('continue')}
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Purchase Order.

            No remount key on the form. It existed to make the pickers pick up
            a value loaded from an existing order, which controlled inputs do
            on their own — and remounting cleared whatever else had been typed:
            choosing a currency wiped the supplier chosen a moment earlier. */}
        {currentStep === 1 && savedOrders.length === 0 && (
          <ValidatedForm onSubmit={handleStep2Submit} className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('purchaseOrder')}</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('supplier')} <span className="text-red-500">*</span>
                </label>
                <FieldWithQuickCreate
                  entity="supplier"
                  onCreated={(sup) => setPoSupplierId(sup.id)}
                >
                <Select
                  key={poSupplierId || 'empty-supplier'}
                  name="supplierId"
                  required
                  value={poSupplierId}
                  onChange={setPoSupplierId}
                  placeholder={t('selectSupplier')}
                  options={supplierList.map((s: any) => ({
                    value: s.id,
                    label: s.name,
                    hint: s.contactPerson ?? undefined,
                  }))}
                />
                </FieldWithQuickCreate>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('currency')} <span className="text-red-500">*</span>
                </label>
                <Select
                  name="currency"
                  required
                  value={effectivePoCurrency}
                  placeholder={t('selectCurrency')}
                  onChange={(v) => {
                    setPoCurrency(v);
                    // Fill the rate in from the currency. It stays editable —
                    // the order is costed at the rate it was actually agreed at.
                    setPoFxRate(v === 'EGP' ? formatRate(1) : rates[v] != null ? formatRate(rates[v]) : '');
                  }}
                  options={['CNY', 'AED', 'USD', 'EGP'].map((c) => ({
                    value: c,
                    label: c,
                    hint: c === 'EGP' ? undefined : rates[c] != null ? `${rates[c]} EGP` : t('noRateSet'),
                  }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('fxRateToEgp')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  name="fxRateToEgp"
                  required
                  step="0.0001"
                  placeholder="0"
                  value={poFxRate}
                  onChange={(e) => setPoFxRate(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  {effectivePoCurrency && rates[effectivePoCurrency] != null
                    ? t('currentRate', {
                        currency: effectivePoCurrency,
                        rate: String(rates[effectivePoCurrency]),
                      })
                    : effectivePoCurrency
                      ? t('noRateRecorded', { currency: effectivePoCurrency })
                      : t('pickCurrencyFirst')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('orderedDate')} <span className="text-red-500">*</span>
                </label>
                {/* Today in Cairo unless changed (§7a); an order cannot be
                    dated forward, so neither can the picker. */}
                <DatePicker
                  name="orderedOn"
                  required
                  disableFuture
                  value={poOrderedOn || businessToday()}
                  onChange={setPoOrderedOn}
                />
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('lineItems')}</h3>
                <button
                  type="button"
                  onClick={addLineItem}
                  className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  <Plus className="h-3.5 w-3.5" /> {t('addItem')}
                </button>
              </div>

              {lineItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-lg">
                  {t('noItemsYet')}
                </p>
              ) : (
                <div className="space-y-3">
                  {lineItems.map((item, idx) => (
                    <div
                      key={idx}
                      data-testid="wizard-line-item"
                      className="flex items-end gap-2 bg-gray-50 rounded-lg p-3"
                    >
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">
                          {t('product')}
                        </label>
                        <FieldWithQuickCreate
                          entity="product"
                          onCreated={(prod) => updateLineItem(idx, 'productId', prod.id)}
                        >
                        <Select
                          value={item.productId}
                          onChange={(v) => updateLineItem(idx, 'productId', v)}
                          required
                          placeholder={t('selectProduct')}
                          options={productList.map((p: any) => ({
                            value: p.id,
                            label: p.name,
                            hint: p.sku,
                          }))}
                        />
                        </FieldWithQuickCreate>
                      </div>

                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">
                          {t('qty')}
                        </label>
                        <input
                          type="number"
                          placeholder="0"
                          data-field="orderedQty"
                          value={item.orderedQty || ''}
                          onChange={(e) =>
                            updateLineItem(idx, 'orderedQty', Number(e.target.value))
                          }
                          {...selectOnFocus}
                          required
                          min="1"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="w-24">
                        <label className="block text-xs text-gray-500 mb-1">
                          {t('unitPrice')}
                        </label>
                        <MoneyInput
                          data-field="unitPrice"
                          placeholder="0.00"
                          value={item.unitPrice || ''}
                          onChange={(raw) => updateLineItem(idx, 'unitPrice', Number(raw))}
                          required
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">
                          {t('discount')}
                        </label>
                        <MoneyInput
                          data-field="discount"
                          placeholder="0.00"
                          value={item.discount || ''}
                          onChange={(raw) => updateLineItem(idx, 'discount', Number(raw))}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => removeLineItem(idx)}
                        aria-label={t('removeItem')}
                        className="p-1.5 text-red-400 hover:text-red-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(0)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-4 w-4" /> {t('back')}
              </button>
              <button
                type="submit"
                disabled={isStep2Loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep2Loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('saveAndContinueBtn')}
              </button>
            </div>
          </ValidatedForm>
        )}

        {/* Step 3 — Shipping Legs. Every date here is optional: a cycle set up
            the day it is ordered has none yet, and finishing then leaves it in
            Purchasing. */}
        {currentStep === 2 && (
          <ValidatedForm
            ref={legFormRef}
            onSubmit={handleStep3Submit}
            onChange={rememberLegFields}
            onClick={rememberLegFields}
            onKeyUp={rememberLegFields}
            className="space-y-6"
          >
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{t('shipping')}</h2>
              <p className="text-sm text-gray-500 mt-1">
                {originType === 'UAE_DIRECT'
                  ? t('oneLegNote')
                  : t('twoLegNote')}
              </p>
            </div>

            {legPlan.map((leg) => {
              const prefix = `leg${leg.sequence}_`;
              const existing = cycle?.shippingLegs?.find(
                (l: any) => l.sequence === leg.sequence,
              );
              return (
                <div
                  key={leg.sequence}
                  data-testid={`wizard-leg-${leg.sequence}`}
                  className="rounded-xl border border-gray-200 p-4 space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-600 text-white text-xs font-semibold">
                      {leg.sequence}
                    </span>
                    <h3 className="text-sm font-semibold text-gray-900">{leg.label}</h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('shippingProvider')} <span className="text-red-500">*</span>
                      </label>
                      <FieldWithQuickCreate
                        entity="provider"
                        onCreated={(pr) => setLegProviderId(prefix, pr.id)}
                      >
                      <Select
                        name={`${prefix}providerId`}
                        required
                        // A provider chosen or created here wins; then one
                        // picked on an earlier visit and not saved; otherwise
                        // the leg's own, which for an older leg may be only a
                        // name.
                        value={
                          legProviderIds[prefix] ??
                          typedLeg(`${prefix}providerId`) ??
                          existing?.providerId ??
                          providerList.find((pr: any) => pr.name === existing?.provider)?.id ??
                          (existing?.provider ? `name:${existing.provider}` : '')
                        }
                        onChange={(v) => setLegProviderId(prefix, v)}
                        placeholder={t('selectShippingProvider')}
                        options={providerOptions(existing?.provider)}
                      />
                      </FieldWithQuickCreate>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('trackingReference')}{' '}
                        <span className="text-gray-400 text-xs font-normal">{t('optional')}</span>
                      </label>
                      <input
                        type="text"
                        name={`${prefix}trackingRef`}
                        defaultValue={typedLeg(`${prefix}trackingRef`) ?? existing?.trackingRef ?? ''}
                        placeholder={t('trackingNumber')}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('origin')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name={`${prefix}origin`}
                        required
                        defaultValue={typedLeg(`${prefix}origin`) ?? existing?.origin ?? leg.origin}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('destination')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        name={`${prefix}destination`}
                        required
                        defaultValue={
                          typedLeg(`${prefix}destination`) ?? existing?.destination ?? leg.destination
                        }
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('departedOn')}{' '}
                        <span className="text-gray-400 text-xs font-normal">{t('optional')}</span>
                      </label>
                      <DatePicker
                        name={`${prefix}departedOn`}
                        disableFuture
                        defaultValue={
                          typedLeg(`${prefix}departedOn`) ?? existing?.departedOn?.slice(0, 10)
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t('arrivedOn')}{' '}
                        <span className="text-gray-400 text-xs font-normal">{t('optional')}</span>
                      </label>
                      <DatePicker
                        name={`${prefix}arrivedOn`}
                        disableFuture
                        defaultValue={
                          typedLeg(`${prefix}arrivedOn`) ?? existing?.arrivedOn?.slice(0, 10)
                        }
                      />
                    </div>
                  </div>

                  <ShippingCostFields
                    namePrefix={prefix}
                    title={t('legCost', { leg: leg.label })}
                    orderedPieces={orderedPieces}
                    defaults={legCostDefaults(prefix, existing)}
                  />
                </div>
              );
            })}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(1)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-4 w-4" /> {t('back')}
              </button>
              <button
                type="submit"
                disabled={isStep3Loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep3Loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('saveAndContinueBtn')}
              </button>
            </div>
          </ValidatedForm>
        )}

        {/* Step 4 — Funding, and finish */}
        {currentStep === LAST_STEP && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-foreground">{t('step4Title')}</h2>

            {/* Funding.

                Asked here because this is the first point where the cycle's
                real cost is known — goods plus shipping — and the last point
                before it leaves the wizard. It used to live on another page,
                which made it a step you could finish without. */}
            {participants.length > 0 && (
              <div className="rounded-xl border border-gray-200 p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">{t('funding')}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{t('fundingHint')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={splitEqually}
                    disabled={landedTotal <= 0}
                    className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t('splitEqually')}
                  </button>
                </div>

                <div className="space-y-2">
                  {participants.map((p: any) => (
                    <div key={p.id} className="flex items-center gap-3">
                      <span className="flex-1 text-sm text-gray-700">
                        {participantName(p)}
                        {p.participantType !== 'CORE_PARTNER' && (
                          <span className="ms-2 text-xs text-purple-600">
                            {t('tempInvestorTag')}
                          </span>
                        )}
                      </span>
                      <MoneyInput
                        data-field={`contribution-${p.id}`}
                        placeholder="0.00"
                        value={contributions[p.id] ?? ''}
                        onChange={(raw) =>
                          setContributions((prev) => ({ ...prev, [p.id]: raw }))
                        }
                        className="w-40 rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                  ))}
                </div>

                {/* Adding an investor.

                    A cycle starts with the three partners on it and there was
                    no way to put anyone else there from the wizard at all —
                    the only route was a separate page most people would never
                    find. A temporary investor is funding like any other, so it
                    is asked for in the same place. */}
                <div className="border-t border-gray-100 pt-3">
                  <p className="text-xs font-medium text-gray-700 mb-2">{t('addInvestor')}</p>
                  {addableUsers.length === 0 ? (
                    <p className="text-xs text-gray-400">{t('everyoneIsOn')}</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[12rem] flex-1">
                        <label className="block text-[11px] text-gray-500 mb-1">
                          {t('investorPerson')}
                        </label>
                        <Select
                          value={investorUserId}
                          onChange={setInvestorUserId}
                          placeholder={t('selectPerson')}
                          options={addableUsers.map((u: any) => ({
                            value: u.id,
                            label: u.partner?.displayName ?? u.email,
                            hint: u.email,
                          }))}
                        />
                      </div>
                      <div className="w-32">
                        <label className="block text-[11px] text-gray-500 mb-1">
                          {t('investorAmount')}
                        </label>
                        <MoneyInput
                          data-field="investor-amount"
                          placeholder="0.00"
                          value={investorAmount}
                          onChange={setInvestorAmount}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="w-24">
                        <label
                          className="block text-[11px] text-gray-500 mb-1"
                          title={t('investorFeeHint')}
                        >
                          {t('investorFee')}
                        </label>
                        <input
                          type="number"
                          name="investorFeePct"
                          min="0"
                          max="100"
                          step="0.01"
                          placeholder="0"
                          value={investorFee}
                          onChange={(e) => setInvestorFee(e.target.value)}
                          {...selectOnFocus}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void addInvestor()}
                        disabled={!investorUserId || isAddingInvestor}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {isAddingInvestor && <Loader2 className="h-3 w-3 animate-spin" />}
                        {t('addInvestorAction')}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 text-xs">
                  <span className="text-gray-500">
                    {t('cycleCost')}:{' '}
                    <span className="font-medium text-gray-900">
                      <Money value={landedTotal} />
                    </span>
                    {' · '}
                    {t('funded')}:{' '}
                    <span className="font-medium text-gray-900">
                      <Money value={fundedTotal} />
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void saveFunding()}
                    disabled={isFunding || isFinishing}
                    className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                  >
                    {isFunding && <Loader2 className="h-3 w-3 animate-spin" />}
                    {tc('save')}
                  </button>
                </div>

                {/* Not blocking — a cycle can legitimately be funded for less
                    than it cost, or by someone outside the system. But it is
                    said plainly, because the settlement will not say it. */}
                {fundedTotal <= 0 ? (
                  <p className="text-xs text-amber-700">{t('notFundedYet')}</p>
                ) : Math.abs(fundedTotal - landedTotal) > 0.01 && landedTotal > 0 ? (
                  <p className="text-xs text-amber-700">
                    {fundedTotal < landedTotal
                      ? t('fundingShort', {
                          amount: (landedTotal - fundedTotal).toFixed(2),
                        })
                      : t('fundingOver', {
                          amount: (fundedTotal - landedTotal).toFixed(2),
                        })}
                  </p>
                ) : null}
              </div>
            )}

            {/* What finishing does, said before the click: the cycle moves as
                far as its dates allow, and receiving is on the cycle page. */}
            <p className="text-sm text-muted-foreground">{t('finishHint')}</p>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => setCurrentStep(2)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-4 w-4" /> {t('back')}
              </button>
              <button
                type="button"
                onClick={() => void handleFinish()}
                disabled={isFinishing || isFunding}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isFinishing && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('finish')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
