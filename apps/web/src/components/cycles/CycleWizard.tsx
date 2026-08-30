'use client';
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
import {
  useCycleWizardDraft,
  draftIsWorthKeeping,
  type CycleWizardDraft,
} from '../../stores/cycle-wizard-draft';
import {
  Route,
  ShoppingCart,
  Truck,
  Package,
  CheckCircle2,
  Plus,
  X,
  ArrowLeft,
  Loader2,
} from 'lucide-react';

import { useApiError } from '../../lib/api-error';
import { FieldWithQuickCreate } from '../ui/quick-create';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS = [
  { titleKey: 'step1Title', icon: Route },
  { titleKey: 'step2Title', icon: ShoppingCart },
  { titleKey: 'step3Title', icon: Truck },
  { titleKey: 'step4Title', icon: Package },
] as const;

const COMPLETED_STATUSES = ['VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LineItem {
  productId: string;
  orderedQty: number;
  unitPrice: number;
  discount: number;
}

interface ReceiveItem {
  purchaseOrderItemId: string;
  productId: string;
  receivedQty: number;
  landedUnitCostEgp: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CycleWizard({ existingCycleId }: { existingCycleId?: string }) {
  const apiError = useApiError();
  const router = useRouter();
  const queryClient = useQueryClient();

  /**
   * Drop the cached cycle lists.
   *
   * The wizard writes cycles but never told the cache, so leaving it landed
   * on a list still showing the state from before — the change was saved and
   * invisible until a manual refresh.
   */
  const refreshCycleCaches = () => {
    queryClient.invalidateQueries({ queryKey: ['cycles'] });
    queryClient.invalidateQueries({ queryKey: ['cycle'] });
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

  // Step 2 line items
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Step 4 receive items
  const [receiveItems, setReceiveItems] = useState<ReceiveItem[]>([]);

  // Step 2 form state for back-navigation pre-population
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poCurrency, setPoCurrency] = useState('');
  const [poFxRate, setPoFxRate] = useState('');
  const rates = useCurrencyRates();
  // Which saved leg each sequence maps to, so a second pass through step 3
  // updates the legs instead of trying to create them again.
  const [legIds, setLegIds] = useState<Record<number, string>>({});

  const [poOrderedOn, setPoOrderedOn] = useState('');

  // Step 3 form state for back-navigation pre-population
  const [shippingProvider, setShippingProvider] = useState('');
  const [shippingOrigin, setShippingOrigin] = useState('');
  const [shippingDestination, setShippingDestination] = useState('');
  const [shippingTrackingRef, setShippingTrackingRef] = useState('');
  const [shippingDepartedOn, setShippingDepartedOn] = useState('');
  const [shippingArrivedOn, setShippingArrivedOn] = useState('');
  const [shippingAmount, setShippingAmount] = useState('');

  // Step 4 local loading state
  const [isStep4Processing, setIsStep4Processing] = useState(false);

  // Shipping leg ID for back-navigation duplicate prevention
  const [shippingLegId, setShippingLegId] = useState<string | null>(null);
  const [isCreatingLegs, setIsCreatingLegs] = useState(false);
  const [costingWarnings, setCostingWarnings] = useState<string[]>([]);
  const receiveInitRef = useRef<string | null>(null);

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
    shippingLegId,
    originType,
    poSupplierId,
    poCurrency,
    poFxRate,
    poOrderedOn,
    lineItems,
    receiveItems,
    shippingProvider,
    shippingOrigin,
    shippingDestination,
    shippingTrackingRef,
    shippingDepartedOn,
    shippingArrivedOn,
    shippingAmount,
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
    setCurrentStep(draft.currentStep);
    setMaxStepReached(draft.maxStepReached);
    setCycleId(draft.cycleId);
    setCycleCode(draft.cycleCode);
    setPoId(draft.poId);
    setPoReference(draft.poReference);
    setLegIds(draft.legIds);
    setShippingLegId(draft.shippingLegId);
    setOriginType(draft.originType);
    setPoSupplierId(draft.poSupplierId);
    setPoCurrency(draft.poCurrency);
    setPoFxRate(draft.poFxRate);
    setPoOrderedOn(draft.poOrderedOn);
    setLineItems(draft.lineItems);
    setReceiveItems(draft.receiveItems);
    setShippingProvider(draft.shippingProvider);
    setShippingOrigin(draft.shippingOrigin);
    setShippingDestination(draft.shippingDestination);
    setShippingTrackingRef(draft.shippingTrackingRef);
    setShippingDepartedOn(draft.shippingDepartedOn);
    setShippingArrivedOn(draft.shippingArrivedOn);
    setShippingAmount(draft.shippingAmount);

    // Step 4 seeds its rows from the purchase order the first time it is
    // shown. The restored rows already carry edited landed costs, so mark the
    // seeding done for this order or it would overwrite them.
    if (draft.poId && draft.receiveItems.length > 0) {
      receiveInitRef.current = draft.poId;
    }
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewWizard, draftHydrated, storedDraft]);

  // Keep the saved draft in step with the form.
  //
  // Waits for the restore above: saving first would write the wizard's empty
  // initial state over the draft it is about to read.
  useEffect(() => {
    if (!isNewWizard || !draftHydrated || !draftRestoredRef.current) return;
    if (!draftIsWorthKeeping(currentDraft)) return;
    saveDraft(currentDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    shippingLegId,
    originType,
    poSupplierId,
    poCurrency,
    poFxRate,
    poOrderedOn,
    lineItems,
    receiveItems,
    shippingProvider,
    shippingOrigin,
    shippingDestination,
    shippingTrackingRef,
    shippingDepartedOn,
    shippingArrivedOn,
    shippingAmount,
  ]);

  /**
   * The success screen means the cycle exists in full. Nothing is a draft any
   * more, so drop it — otherwise the next new cycle would open on the finished
   * one. Declared after the save effect so it wins on the render that arrives
   * at the last step.
   */
  useEffect(() => {
    if (!isNewWizard || currentStep !== 4) return;
    forgetDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewWizard, currentStep]);

  // ---------------------------------------------------------------------------
  // Fetch existing cycle data for resume
  // ---------------------------------------------------------------------------

  const {
    data: existingCycle,
    isLoading: isLoadingCycle,
    refetch: refetchCycle,
  } = useQuery({
    queryKey: ['cycle', existingCycleId],
    queryFn: () => api.get(`/cycles/${existingCycleId}`).then((r) => r.data.data ?? r.data),
    enabled: !!existingCycleId,
  });

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
  const { data: fundingCycle, refetch: refetchFunding } = useQuery({
    queryKey: ['cycle', 'funding', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId && currentStep === 3,
  });

  const participants: any[] = fundingCycle?.participants ?? [];

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
  }, [participants.length]);

  // What the cycle has actually cost: goods from step 2 plus shipping from
  // step 3, which is the number the partners are funding.
  const { data: landedCost } = useQuery({
    queryKey: ['costing', cycleId],
    queryFn: () =>
      api.get(`/costing/cycles/${cycleId}/landed-cost`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId && currentStep === 3,
  });

  /**
   * Everyone who could still be put on this cycle.
   *
   * A temporary investor is an ordinary user given money in one cycle, so the
   * list is everybody not already a participant — not only users whose role
   * says TEMP_INVESTOR. A core partner backing a cycle separately is a real
   * case, and the demo data has one.
   */
  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => r.data.data ?? r.data),
    enabled: !!cycleId && currentStep === 3,
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
      await refetchFunding();
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

  const saveFunding = async () => {
    setIsFunding(true);
    try {
      for (const p of participants) {
        const next = Number(contributions[p.id] || 0);
        if (next === Number(p.contributionAmount)) continue;
        await api.put(`/cycles/participants/${p.id}`, { contributionAmount: next });
      }
      await refetchFunding();
      refreshCycleCaches();
      toast.success(t('fundingSaved'));
    } catch (err: any) {
      toast.error(apiError(err, t('fundingFailed')));
    } finally {
      setIsFunding(false);
    }
  };

  // Stock already received for this cycle, keyed by the purchase order item it
  // came from. A batch keeps the landed cost it was received at for good — the
  // same rule that stops a supplier refund re-pricing sold goods — so these
  // rows are history, not something the wizard offers to redo.
  const receivedByPoItem = new Map<string, any>(
    (existingCycle?.inventoryBatches ?? []).map((b: any) => [b.sourcePoItemId, b]),
  );

  // The currency the purchase order step is showing: the one already chosen on
  // this order, or failing that the cycle's own.
  const effectivePoCurrency = poCurrency || existingCycle?.currency || '';

  // Fill in the rate for a currency that is already selected. Resuming a cycle
  // set to AED preselected the currency but left the rate blank, because the
  // rate was only ever filled by the act of changing the currency — so the one
  // case where nothing needs changing was the case it did not cover. A rate
  // already on the order is left alone.
  useEffect(() => {
    if (!effectivePoCurrency || effectivePoCurrency === 'EGP') return;
    const known = rates[effectivePoCurrency];
    if (known == null) return;
    setPoFxRate((prev) => (prev ? prev : String(known)));
  }, [effectivePoCurrency, rates]);

  // Determine resume step when existing cycle loads
  useEffect(() => {
    if (!existingCycle || !isResuming) return;

    setCycleId(existingCycle.id);
    setCycleCode(existingCycle.code);
    setOriginType(existingCycle.originType ?? '');

    const hasPO = existingCycle.purchaseOrders && existingCycle.purchaseOrders.length > 0;
    const hasShipping = existingCycle.shippingLegs && existingCycle.shippingLegs.length > 0;
    const isCompleted = COMPLETED_STATUSES.includes(existingCycle.status);

    if (isCompleted) {
      // Already verified or beyond — show completion
      if (hasPO) {
        const po = existingCycle.purchaseOrders[0];
        setPoId(po.id);
        setPoReference(po.reference);
        setPoSupplierId(po.supplierId ?? '');
        setPoCurrency(po.currency ?? '');
        setPoFxRate(String(po.fxRateToEgp ?? ''));
        setPoOrderedOn(po.orderedOn ? new Date(po.orderedOn).toISOString().split('T')[0] : '');
      }
      if (hasShipping) {
        const sl = existingCycle.shippingLegs[0];
        setShippingProvider(sl.provider ?? '');
        setShippingOrigin(sl.origin ?? '');
        setShippingDestination(sl.destination ?? '');
        setShippingTrackingRef(sl.trackingRef ?? '');
        setShippingDepartedOn(sl.departedOn ? new Date(sl.departedOn).toISOString().split('T')[0] : '');
        setShippingArrivedOn(sl.arrivedOn ? new Date(sl.arrivedOn).toISOString().split('T')[0] : '');
        setShippingAmount(String(sl.amount ?? ''));
        setShippingLegId(sl.id ?? null);
      }
      setCurrentStep(4);
    } else if (hasPO && hasShipping) {
      // Has PO + shipping but not verified → step 4
      const po = existingCycle.purchaseOrders[0];
      setPoId(po.id);
      setPoReference(po.reference);
      setPoSupplierId(po.supplierId ?? '');
      setPoCurrency(po.currency ?? '');
      setPoFxRate(String(po.fxRateToEgp ?? ''));
      setPoOrderedOn(po.orderedOn ? new Date(po.orderedOn).toISOString().split('T')[0] : '');
      // Pre-populate line items from existing PO
      if (po.items && po.items.length > 0) {
        setLineItems(po.items.map((item: any) => ({
          productId: item.productId,
          productName: item.product?.name ?? '',
          orderedQty: Number(item.orderedQty),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount ?? 0),
        })));
      }
      const sl = existingCycle.shippingLegs[0];
      setShippingProvider(sl.provider ?? '');
      setShippingOrigin(sl.origin ?? '');
      setShippingDestination(sl.destination ?? '');
      setShippingTrackingRef(sl.trackingRef ?? '');
      setShippingDepartedOn(sl.departedOn ? new Date(sl.departedOn).toISOString().split('T')[0] : '');
      setShippingArrivedOn(sl.arrivedOn ? new Date(sl.arrivedOn).toISOString().split('T')[0] : '');
      setShippingAmount(String(sl.amount ?? ''));
      setShippingLegId(sl.id ?? null);
      setCurrentStep(3);
    } else if (hasPO) {
      // Has PO but no shipping → step 3
      const po = existingCycle.purchaseOrders[0];
      setPoId(po.id);
      setPoReference(po.reference);
      setPoSupplierId(po.supplierId ?? '');
      setPoCurrency(po.currency ?? '');
      setPoFxRate(String(po.fxRateToEgp ?? ''));
      setPoOrderedOn(po.orderedOn ? new Date(po.orderedOn).toISOString().split('T')[0] : '');
      // Pre-populate line items from existing PO
      if (po.items && po.items.length > 0) {
        setLineItems(po.items.map((item: any) => ({
          productId: item.productId,
          productName: item.product?.name ?? '',
          orderedQty: Number(item.orderedQty),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount ?? 0),
        })));
      }
      setCurrentStep(2);
    } else {
      // Cycle exists but no PO → step 2
      setCurrentStep(1);
    }

    setIsResuming(false);
  }, [existingCycle, isResuming]);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get('/suppliers').then((r) => r.data.data ?? r.data),
    enabled: currentStep >= 1,
  });

  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data.data ?? r.data),
    enabled: currentStep >= 1,
  });

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
    enabled: currentStep === 2,
  });

  const { data: poDetail } = useQuery({
    queryKey: ['purchase', poId],
    queryFn: () => api.get(`/purchases/${poId}`).then((r) => r.data.data ?? r.data),
    enabled: currentStep >= 2 && !!poId,
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
    onSuccess: (res, _variables) => {
      const result = res.data.data ?? res.data;
      setPoId(result.id);
      setPoReference(result.reference);
      // Save form values for back-navigation
      setPoSupplierId(_variables.supplierId);
      setPoCurrency(_variables.currency);
      setPoFxRate(String(_variables.fxRateToEgp));
      setPoOrderedOn(_variables.orderedOn ?? '');
      setCurrentStep(2);
      toast.success(t('purchaseCreated'));
    },
    onError: (err: any) => {
      toast.error(apiError(err, t('createPurchaseFailed')));
    },
  });

  const createShippingMutation = useMutation({
    mutationFn: (data: any) => api.post(`/cycles/${cycleId}/shipping-legs`, data),
    onSuccess: (res) => {
      const result = res.data.data ?? res.data;
      setShippingLegId(result.id ?? null);
      setCurrentStep(3);
      toast.success(t('shippingCreated'));
    },
    onError: (err: any) => {
      toast.error(apiError(err, t('createShippingFailed')));
    },
  });

  const verifyInventoryMutation = useMutation({
    mutationFn: (data: any) => api.post('/receipts/verify', data),
    onSuccess: () => {
      setCurrentStep(4);
      refreshCycleCaches();
      toast.success(t('inventoryVerified'));
    },
    onError: (err: any) => {
      toast.error(apiError(err, t('verifyInventoryFailed')));
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

    // Save form values for back-navigation
    setPoSupplierId(String(fd.get('supplierId') || ''));
    setPoCurrency(String(fd.get('currency') || ''));
    setPoFxRate(String(fd.get('fxRateToEgp') || ''));
    setPoOrderedOn(String(fd.get('orderedOn') || ''));

    // If PO already exists (going back), just advance to next step
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

  // What the cycle actually bought, used to prefill each leg's piece count.
  const orderedPieces = lineItems.reduce((sum, item) => sum + Number(item.orderedQty || 0), 0);

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
        arrivedOn: str('arrivedOn') || undefined,
        ...readShippingCostFields(fd, prefix),
      };
    });

    // Keep the first leg's values for back-navigation display.
    setShippingOrigin(payloads[0].origin);
    setShippingDestination(payloads[payloads.length - 1].destination);
    setShippingProvider(payloads[0].provider);

    setIsCreatingLegs(true);
    try {
      let firstId: string | null = null;
      const savedIds: Record<number, string> = {};
      let updated = false;

      for (const body of payloads) {
        // A leg already saved for this sequence is edited, not recreated.
        // Returning early here instead — which is what this did — threw away
        // every change made on a second visit: dates, provider, costs, all of
        // it, with a success step and no warning.
        const existingId =
          legIds[body.sequence] ??
          existingCycle?.shippingLegs?.find((l: any) => l.sequence === body.sequence)?.id;

        // `sequence` identifies the leg and is uniquely constrained, so an
        // update must not carry it — the endpoint rejects it outright.
        const { sequence: _seq, ...updatable } = body;

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
        if (!firstId) firstId = saved.id ?? existingId;
      }

      setLegIds((prev) => ({ ...prev, ...savedIds }));
      setShippingLegId(firstId);
      refreshCycleCaches();
      // The cycle query holds the legs the form reads back; without this the
      // next visit would show what was on screen before this save.
      await refetchCycle();
      toast.success(
        updated
          ? t('legsUpdated', { count: payloads.length })
          : t('legsCreated', { count: payloads.length }),
      );
      setCurrentStep(3);
    } catch (err: any) {
      toast.error(
        apiError(err, t('saveShippingLegsFailed')),
      );
    } finally {
      setIsCreatingLegs(false);
    }
  };

  const handleStep4Submit = async () => {
    setIsStep4Processing(true);
    try {
      const cycleRes = await api.get(`/cycles/${cycleId}`);
      const currentStatus = (cycleRes.data.data ?? cycleRes.data).status;
      const cycleOriginType = (cycleRes.data.data ?? cycleRes.data).originType;

      // CHINA: PLANNING → FUNDING → PURCHASING → IN_TRANSIT → ARRIVED_UAE → IN_TRANSIT_TO_EGYPT → ARRIVED_EGYPT → VERIFICATION
      // UAE_DIRECT: PLANNING → FUNDING → PURCHASING → ARRIVED_UAE → IN_TRANSIT_TO_EGYPT → ARRIVED_EGYPT → VERIFICATION
      const chinaTransitions = ['FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION'];
      const uaeTransitions = ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION'];
      const allTransitions = cycleOriginType === 'UAE_DIRECT' ? uaeTransitions : chinaTransitions;
      const allStatuses = ['PLANNING', ...allTransitions];
      const startIdx = allStatuses.indexOf(currentStatus);

      // The shipment has to have actually arrived before any of this. Walking
      // the cycle to VERIFICATION in one click is what made a cycle approved a
      // moment ago have sellable stock — the goods departed, arrived and were
      // received in the same instant, with no dates recorded anywhere.
      //
      // The server refuses each step it has not reached, but checking here
      // means saying which leg and what is missing, rather than stopping
      // half-way with the cycle in some middle state.
      const legsRes = await api.get(`/cycles/${cycleId}/shipping-legs`);
      const legs = legsRes.data.data ?? legsRes.data ?? [];
      const notArrived = legs.filter((l: any) => l.status !== 'ARRIVED');

      if (notArrived.length > 0) {
        const which = notArrived
          .map((l: any) => `${l.origin} → ${l.destination}`)
          .join(', ');
        toast.error(
          t('legNotArrived', { leg: which }),
        );
        setCurrentStep(2);
        return;
      }

      if (startIdx >= 0) {
        const transitionsNeeded = allTransitions.slice(startIdx);
        for (const status of transitionsNeeded) {
          await api.post(`/cycles/${cycleId}/transition`, { status });
        }
      }

      // The loop above has already walked the cycle to VERIFICATION, which is
      // what takes it off the "resume" list — so a cycle whose stock is all in
      // still finishes here rather than dead-ending.
      //
      // Only what has not been received yet is sent. An already-received item
      // is refused outright by the server (one batch per purchase order item),
      // and that refusal used to fail the whole step at the last click.
      const outstanding = receiveItems.filter(
        (item) => !receivedByPoItem.has(item.purchaseOrderItemId),
      );

      if (outstanding.length === 0) {
        await refetchCycle();
        refreshCycleCaches();
        toast.success(
          currentStatus === 'VERIFICATION'
            ? t('stockAlreadyReceived')
            : t('stockReceivedMovedOn'),
        );
        forgetDraft();
        router.push(`/${locale}/cycles`);
        return;
      }

      await verifyInventoryMutation.mutateAsync({
        cycleId,
        items: outstanding.map((item) => ({
          purchaseOrderItemId: item.purchaseOrderItemId,
          productId: item.productId,
          receivedQty: item.receivedQty,
          landedUnitCostEgp: item.landedUnitCostEgp,
        })),
      });
    } catch (err: any) {
      toast.error(apiError(err, t('verifyInventoryFailed')));
    } finally {
      setIsStep4Processing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Line item helpers (Step 2)
  // ---------------------------------------------------------------------------

  const addLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      { productId: '', orderedQty: 0, unitPrice: 0, discount: 0 },
    ]);
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
  // Receive items initializer (Step 4)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (currentStep !== 3 || !poDetail?.items) return;
    // Guard with a ref, not receiveItems.length: seeding the rows would
    // re-run this effect and its cleanup would cancel the in-flight fetch.
    if (receiveInitRef.current === poId) return;
    receiveInitRef.current = poId;

    // Seed with the goods price, then replace with the landed cost once the
    // API has spread this cycle's shipping across the purchased items.
    const seed = poDetail.items.map((item: any) => ({
      purchaseOrderItemId: item.id,
      productId: item.productId,
      receivedQty: item.orderedQty,
      landedUnitCostEgp: item.unitPrice,
    }));
    setReceiveItems(seed);

    api
      .get(`/costing/cycles/${cycleId}/landed-cost`)
      .then((res) => {
        const payload = res.data.data ?? res.data;
        const byItem = new Map<string, string>(
          (payload.items ?? []).map((i: any) => [
            i.purchaseOrderItemId,
            i.landedUnitCostEgp,
          ]),
        );
        setReceiveItems((prev) =>
          prev.map((it) => {
            const landed = byItem.get(it.purchaseOrderItemId);
            if (landed === undefined) return it;
            const n = Number(landed);
            return Number.isFinite(n) ? { ...it, landedUnitCostEgp: n } : it;
          }),
        );
        setCostingWarnings(payload.warnings ?? []);
      })
      .catch(() => {
        /* keep the goods-price seed if costing is unavailable */
      });
  }, [currentStep, poDetail, poId, cycleId]);

  const updateReceiveItem = (idx: number, field: keyof ReceiveItem, value: any) => {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    );
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
    setLineItems([]);
    setReceiveItems([]);
    setPoSupplierId('');
    setPoCurrency('');
    setPoFxRate('');
    setPoOrderedOn('');
    setShippingProvider('');
    setShippingOrigin('');
    setShippingDestination('');
    setShippingTrackingRef('');
    setShippingDepartedOn('');
    setShippingArrivedOn('');
    setShippingAmount('');
    setShippingLegId(null);
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
  const poItems: any[] = poDetail?.items ?? [];

  // Step 1 query-level loading
  const isStep1Loading = createCycleMutation.isPending;
  const isStep2Loading = createPoMutation.isPending;
  const isStep3Loading = createShippingMutation.isPending || isCreatingLegs;

  // ---------------------------------------------------------------------------
  // Loading state for resume
  // ---------------------------------------------------------------------------

  if (isLoadingCycle) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary-600 me-3" />
        <span className="text-gray-500 text-sm">{t('loadingCycle')}</span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Completion screen
  // ---------------------------------------------------------------------------

  if (currentStep === 4) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-6" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('allDone')}</h2>
          <p className="text-gray-500 mb-8 max-w-md mx-auto">
            {t('allDoneDesc')}
          </p>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg mx-auto mb-8">
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">{t('cycleCode')}</p>
              <p className="font-mono font-bold text-gray-900">{cycleCode}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">{t('poReference')}</p>
              <p className="font-mono font-bold text-gray-900">{poReference}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">{t('shipping')}</p>
              <p className="font-bold text-gray-900 text-sm">
                {shippingOrigin} &rarr; {shippingDestination}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => router.push(`/${locale}/cycles`)}
              className="px-6 py-2.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
            >
              {t('viewCycles')}
            </button>
            <button
              onClick={handleStartAnother}
              className="px-6 py-2.5 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              {t('startOver')}
            </button>
          </div>
        </div>
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
          <form onSubmit={handleStep1Submit} className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('cycleInformation')}</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('originType')} <span className="text-red-500">*</span>
              </label>
              <Select
                name="originType"
                required
                value={originType || existingCycle?.originType || ''}
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
                  { value: 'CNY', label: 'CNY (\u00A5)' },
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
          </form>
        )}

        {/* Step 2 — Purchase Order.

            No remount key on the form. It existed to make the pickers pick up
            a value loaded from an existing order, which controlled inputs do
            on their own — and remounting cleared whatever else had been typed:
            choosing a currency wiped the supplier chosen a moment earlier. */}
        {currentStep === 1 && (
          <form onSubmit={handleStep2Submit} className="space-y-5">
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
                    setPoFxRate(v === 'EGP' ? '1' : rates[v] != null ? String(rates[v]) : '');
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
                  key={poFxRate}
                  type="number"
                  name="fxRateToEgp"
                  required
                  step="0.0001"
                  placeholder="0"
                  defaultValue={poFxRate ? Number(poFxRate).toFixed(4) : ''}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  {effectivePoCurrency && rates[effectivePoCurrency] != null
                    ? `Current rate: 1 ${effectivePoCurrency} = ${rates[effectivePoCurrency]} EGP`
                    : effectivePoCurrency
                      ? `No rate recorded for ${effectivePoCurrency} — enter the rate used`
                      : t('pickCurrencyFirst')}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('orderedDate')} <span className="text-red-500">*</span>
                </label>
                <DatePicker name="orderedOn" required defaultValue={poOrderedOn} />
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
          </form>
        )}

        {/* Step 3 — Shipping Legs */}
        {currentStep === 2 && (
          <form onSubmit={handleStep3Submit} className="space-y-6">
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
              const existing = existingCycle?.shippingLegs?.find(
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
                        // A provider chosen or created here wins; otherwise the
                        // leg's own, which for an older leg may be only a name.
                        value={
                          legProviderIds[prefix] ??
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
                        <span className="text-gray-400 text-xs font-normal">(Optional)</span>
                      </label>
                      <input
                        type="text"
                        name={`${prefix}trackingRef`}
                        defaultValue={existing?.trackingRef ?? ''}
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
                        defaultValue={existing?.origin ?? leg.origin}
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
                        defaultValue={existing?.destination ?? leg.destination}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Departed On{' '}
                        <span className="text-gray-400 text-xs font-normal">(Optional)</span>
                      </label>
                      <DatePicker
                        name={`${prefix}departedOn`}
                        defaultValue={existing?.departedOn?.slice(0, 10)}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Arrived On{' '}
                        <span className="text-gray-400 text-xs font-normal">(Optional)</span>
                      </label>
                      <DatePicker
                        name={`${prefix}arrivedOn`}
                        defaultValue={existing?.arrivedOn?.slice(0, 10)}
                      />
                    </div>
                  </div>

                  <ShippingCostFields
                    namePrefix={prefix}
                    title={`${leg.label} cost`}
                    orderedPieces={orderedPieces}
                    defaults={
                      existing
                        ? {
                            costBasis: existing.costBasis ?? 'PER_PIECE',
                            ratePerUnit: existing.ratePerUnit ?? '',
                            chargeablePieces: existing.chargeablePieces ?? '',
                            chargeableWeightKg: existing.chargeableWeightKg ?? '',
                            amount: existing.amount ?? '',
                            currency: existing.currency ?? 'EGP',
                            fxRateToEgp: existing.fxRateToEgp ?? 1,
                          }
                        : undefined
                    }
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
          </form>
        )}

        {/* Step 4 — Receive Inventory */}
        {currentStep === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">{t('receiveInventory')}</h2>
            <p className="text-sm text-gray-500 mb-4">
              Landed unit cost includes this cycle&apos;s shipping, spread across the
              items it moved. Edit a value to override it.
            </p>

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
                        onClick={addInvestor}
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
                      {landedTotal.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      EGP
                    </span>
                    {' · '}
                    {t('funded')}:{' '}
                    <span className="font-medium text-gray-900">
                      {fundedTotal.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      EGP
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={saveFunding}
                    disabled={isFunding}
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

            {costingWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                {costingWarnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-800">
                    {w}
                  </p>
                ))}
              </div>
            )}

            {receiveItems.some((i) => receivedByPoItem.has(i.purchaseOrderItemId)) && (
              <div className="space-y-2 rounded-lg border border-green-200 bg-green-50 p-3">
                <p className="text-xs font-medium text-green-800">
                  Already received into stock — recorded at the cost it was received at,
                  and not re-costed by later changes.
                </p>
                {receiveItems
                  .filter((i) => receivedByPoItem.has(i.purchaseOrderItemId))
                  .map((i) => {
                    const batch = receivedByPoItem.get(i.purchaseOrderItemId);
                    return (
                      <div
                        key={i.purchaseOrderItemId}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm text-green-900"
                      >
                        <span className="font-medium">{batch?.product?.name ?? 'Product'}</span>
                        <span className="text-xs">
                          {Number(batch?.receivedQty ?? 0)} received @{' '}
                          {Number(batch?.landedUnitCostEgp ?? 0).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          EGP
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}

            {receiveItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">
                {t('noPurchaseOrderItems')}
              </p>
            ) : receiveItems.every((i) => receivedByPoItem.has(i.purchaseOrderItemId)) ? (
              <p className="text-sm text-gray-500 text-center py-6 border border-dashed border-gray-200 rounded-lg">
                Everything on this cycle has been received. There is nothing left to
                enter here.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="hidden sm:grid sm:grid-cols-12 gap-2 px-3 text-xs font-medium text-gray-500">
                  <div className="col-span-4">{t('product')}</div>
                  <div className="col-span-2 text-center">{t('ordered')}</div>
                  <div className="col-span-2 text-center">{t('received')}</div>
                  <div className="col-span-4 text-center">{t('landedUnitCost')}</div>
                </div>

                {receiveItems.map((item, idx) => {
                  if (receivedByPoItem.has(item.purchaseOrderItemId)) return null;
                  const poItem = poItems.find((pi: any) => pi.id === item.purchaseOrderItemId);
                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-gray-50 rounded-lg p-3"
                    >
                      <div className="sm:col-span-4">
                        <span className="text-xs text-gray-400 sm:hidden">{t('product')}: </span>
                        <p className="text-sm font-medium text-gray-900">
                          {poItem?.product?.name ?? 'Product'}
                        </p>
                      </div>

                      <div className="sm:col-span-2 text-center">
                        <span className="text-xs text-gray-400 sm:hidden">{t('ordered')}: </span>
                        <span className="text-sm text-gray-600">{poItem?.orderedQty ?? 0}</span>
                      </div>

                      <div className="sm:col-span-2">
                        <span className="text-xs text-gray-400 sm:hidden">{t('received')}: </span>
                        <input
                          type="number"
                          placeholder="0"
                          value={item.receivedQty}
                          onChange={(e) =>
                            updateReceiveItem(idx, 'receivedQty', Number(e.target.value))
                          }
                          {...selectOnFocus}
                          min="0"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <span className="text-xs text-gray-400 sm:hidden">{t('landedUnitCost')}: </span>
                        <MoneyInput
                          data-field="landedUnitCostEgp"
                          placeholder="0.00"
                          value={item.landedUnitCostEgp}
                          onChange={(raw) =>
                            updateReceiveItem(idx, 'landedUnitCostEgp', Number(raw))
                          }
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

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
                onClick={handleStep4Submit}
                disabled={isStep4Processing || receiveItems.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep4Processing && <Loader2 className="h-4 w-4 animate-spin" />}
                {receiveItems.length > 0 &&
                receiveItems.every((i) => receivedByPoItem.has(i.purchaseOrderItemId))
                  ? t('done')
                  : t('complete')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
