'use client';
import { Select } from '../ui/select';
import { DatePicker } from '../ui/date-picker';
import { useCurrencyRates } from '../../lib/currency-rates';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useQuery, useMutation } from '@tanstack/react-query';
import { ShippingCostFields, readShippingCostFields } from '../shipping/ShippingCostFields';
import { api } from '../../lib/api';
import { useToast } from '../ui/toast';
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS = [
  { title: 'Cycle Info', icon: Route },
  { title: 'Purchase Order', icon: ShoppingCart },
  { title: 'Shipping Leg', icon: Truck },
  { title: 'Receive Inventory', icon: Package },
];

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
  const router = useRouter();
  const locale = useLocale();
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
  // Fetch existing cycle data for resume
  // ---------------------------------------------------------------------------

  const { data: existingCycle, isLoading: isLoadingCycle } = useQuery({
    queryKey: ['cycle', existingCycleId],
    queryFn: () => api.get(`/cycles/${existingCycleId}`).then((r) => r.data.data ?? r.data),
    enabled: !!existingCycleId,
  });

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
      toast.success('Cycle created');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to create cycle');
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
      toast.success('Purchase order created');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to create purchase order');
    },
  });

  const createShippingMutation = useMutation({
    mutationFn: (data: any) => api.post(`/cycles/${cycleId}/shipping-legs`, data),
    onSuccess: (res) => {
      const result = res.data.data ?? res.data;
      setShippingLegId(result.id ?? null);
      setCurrentStep(3);
      toast.success('Shipping leg created');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to create shipping leg');
    },
  });

  const verifyInventoryMutation = useMutation({
    mutationFn: (data: any) => api.post('/receipts/verify', data),
    onSuccess: () => {
      setCurrentStep(4);
      toast.success('Inventory verified');
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to verify inventory');
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
      toast.error('Please add at least one line item before submitting');
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
      ? [{ sequence: 1, label: 'UAE to Egypt', origin: 'Dubai, UAE', destination: 'Cairo, Egypt' }]
      : [
          { sequence: 1, label: 'China to UAE', origin: 'Guangzhou, CN', destination: 'Dubai, UAE' },
          { sequence: 2, label: 'UAE to Egypt', origin: 'Dubai, UAE', destination: 'Cairo, Egypt' },
        ];

  // What the cycle actually bought, used to prefill each leg's piece count.
  const orderedPieces = lineItems.reduce((sum, item) => sum + Number(item.orderedQty || 0), 0);

  const handleStep3Submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    // Already created on a previous pass through this step - just advance.
    if (shippingLegId) {
      setCurrentStep(3);
      return;
    }

    const payloads = legPlan.map((leg) => {
      const prefix = `leg${leg.sequence}_`;
      const str = (k: string) => String(fd.get(`${prefix}${k}`) || '');
      return {
        sequence: leg.sequence,
        origin: str('origin'),
        destination: str('destination'),
        provider: str('provider'),
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
      for (const body of payloads) {
        const res = await api.post(`/cycles/${cycleId}/shipping-legs`, body);
        const created = res.data.data ?? res.data;
        if (!firstId) firstId = created.id;
      }
      setShippingLegId(firstId);
      toast.success(
        payloads.length > 1 ? 'Shipping legs created' : 'Shipping leg created',
      );
      setCurrentStep(3);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error?.message ||
          err?.response?.data?.message ||
          'Failed to create shipping legs',
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

      if (startIdx >= 0) {
        const transitionsNeeded = allTransitions.slice(startIdx);
        for (const status of transitionsNeeded) {
          await api.post(`/cycles/${cycleId}/transition`, { status });
        }
      }

      await verifyInventoryMutation.mutateAsync({
        cycleId,
        items: receiveItems.map((item) => ({
          purchaseOrderItemId: item.purchaseOrderItemId,
          productId: item.productId,
          receivedQty: item.receivedQty,
          landedUnitCostEgp: item.landedUnitCostEgp,
        })),
      });
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err?.message || 'Failed to verify inventory');
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
    setCurrentStep(0);
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
        <span className="text-gray-500 text-sm">Loading cycle data…</span>
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
          <h2 className="text-2xl font-bold text-gray-900 mb-2">All Steps Complete!</h2>
          <p className="text-gray-500 mb-8 max-w-md mx-auto">
            Your import cycle has been set up with all purchases, shipping, and
            inventory verification completed.
          </p>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg mx-auto mb-8">
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Cycle Code</p>
              <p className="font-mono font-bold text-gray-900">{cycleCode}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">PO Reference</p>
              <p className="font-mono font-bold text-gray-900">{poReference}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Shipping</p>
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
              View Cycles
            </button>
            <button
              onClick={handleStartAnother}
              className="px-6 py-2.5 border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Start Another Cycle
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
                  {step.title}
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
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Cycle Information</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Origin Type <span className="text-red-500">*</span>
              </label>
              <Select
                key={originType || 'empty-origin'}
                name="originType"
                required
                defaultValue={originType || existingCycle?.originType || ''}
                placeholder="Select origin type"
                options={[
                  { value: 'CHINA', label: 'China' },
                  { value: 'UAE_DIRECT', label: 'UAE Direct' },
                ]}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Currency <span className="text-red-500">*</span>
              </label>
              <Select
                key={poCurrency || 'empty-currency'}
                name="currency"
                required
                defaultValue={poCurrency || existingCycle?.currency || ''}
                placeholder="Select currency"
                options={[
                  { value: 'CNY', label: 'CNY (\u00A5)' },
                  { value: 'AED', label: 'AED' },
                  { value: 'USD', label: 'USD ($)' },
                ].map((o) => ({
                  ...o,
                  hint: rates[o.value] != null ? `${rates[o.value]} EGP` : 'no rate set',
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
                Save &amp; Continue
              </button>
            </div>
          </form>
        )}

        {/* Step 2 — Purchase Order */}
        {currentStep === 1 && (
          <form key={`step2-${poSupplierId}-${poCurrency}`} onSubmit={handleStep2Submit} className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Purchase Order</h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Supplier <span className="text-red-500">*</span>
                </label>
                <Select
                  key={poSupplierId || 'empty-supplier'}
                  name="supplierId"
                  required
                  defaultValue={poSupplierId}
                  placeholder="Select supplier"
                  options={supplierList.map((s: any) => ({
                    value: s.id,
                    label: s.name,
                    hint: s.contactPerson ?? undefined,
                  }))}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Currency <span className="text-red-500">*</span>
                </label>
                <Select
                  key={poCurrency || 'empty-currency'}
                  name="currency"
                  required
                  defaultValue={poCurrency || (existingCycle?.currency ?? '')}
                  placeholder="Select currency"
                  onChange={(v) => {
                    setPoCurrency(v);
                    // Fill the rate in from the currency. It stays editable —
                    // the order is costed at the rate it was actually agreed at.
                    setPoFxRate(v === 'EGP' ? '1' : rates[v] != null ? String(rates[v]) : '');
                  }}
                  options={['CNY', 'AED', 'USD', 'EGP'].map((c) => ({
                    value: c,
                    label: c,
                    hint: c === 'EGP' ? undefined : rates[c] != null ? `${rates[c]} EGP` : 'no rate set',
                  }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  FX Rate to EGP <span className="text-red-500">*</span>
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
                  {poCurrency && rates[poCurrency] != null
                    ? `Current rate: 1 ${poCurrency} = ${rates[poCurrency]} EGP`
                    : poCurrency
                      ? `No rate recorded for ${poCurrency} — enter the rate used`
                      : 'Pick a currency to fill this in'}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ordered Date <span className="text-red-500">*</span>
                </label>
                <DatePicker name="orderedOn" required defaultValue={poOrderedOn} />
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">Line Items</h3>
                <button
                  type="button"
                  onClick={addLineItem}
                  className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Item
                </button>
              </div>

              {lineItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-lg">
                  No items added. Click &quot;Add Item&quot; to begin.
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
                          Product
                        </label>
                        <Select
                          value={item.productId}
                          onChange={(v) => updateLineItem(idx, 'productId', v)}
                          required
                          placeholder="Select product"
                          options={productList.map((p: any) => ({
                            value: p.id,
                            label: p.name,
                            hint: p.sku,
                          }))}
                        />
                      </div>

                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">
                          Qty
                        </label>
                        <input
                          type="number"
                          placeholder="0"
                          value={item.orderedQty || ''}
                          onChange={(e) =>
                            updateLineItem(idx, 'orderedQty', Number(e.target.value))
                          }
                          required
                          min="1"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="w-24">
                        <label className="block text-xs text-gray-500 mb-1">
                          Unit Price
                        </label>
                        <input
                          type="number"
                          placeholder="0"
                          step="0.01"
                          value={item.unitPrice || ''}
                          onChange={(e) =>
                            updateLineItem(idx, 'unitPrice', Number(e.target.value))
                          }
                          required
                          min="0"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">
                          Discount
                        </label>
                        <input
                          type="number"
                          placeholder="0"
                          step="0.01"
                          value={item.discount || ''}
                          onChange={(e) =>
                            updateLineItem(idx, 'discount', Number(e.target.value))
                          }
                          min="0"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
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
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="submit"
                disabled={isStep2Loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep2Loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save &amp; Continue
              </button>
            </div>
          </form>
        )}

        {/* Step 3 — Shipping Legs */}
        {currentStep === 2 && (
          <form onSubmit={handleStep3Submit} className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Shipping</h2>
              <p className="text-sm text-gray-500 mt-1">
                {originType === 'UAE_DIRECT'
                  ? 'This cycle ships directly from UAE to Egypt.'
                  : 'This cycle ships in two legs. Record the cost of each one.'}
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
                        Shipping Provider <span className="text-red-500">*</span>
                      </label>
                      <Select
                        name={`${prefix}provider`}
                        required
                        defaultValue={existing?.provider ?? ''}
                        placeholder="Select shipping provider"
                        options={(Array.isArray(providers) ? providers : []).map((pr: any) => ({
                          value: pr.name,
                          label: pr.name,
                          hint: pr.contactPerson ?? undefined,
                        }))}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Tracking Reference{' '}
                        <span className="text-gray-400 text-xs font-normal">(Optional)</span>
                      </label>
                      <input
                        type="text"
                        name={`${prefix}trackingRef`}
                        defaultValue={existing?.trackingRef ?? ''}
                        placeholder="Tracking number"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Origin <span className="text-red-500">*</span>
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
                        Destination <span className="text-red-500">*</span>
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
                      <DatePicker name={`${prefix}departedOn`} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Arrived On{' '}
                        <span className="text-gray-400 text-xs font-normal">(Optional)</span>
                      </label>
                      <DatePicker name={`${prefix}arrivedOn`} />
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
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="submit"
                disabled={isStep3Loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep3Loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save &amp; Continue
              </button>
            </div>
          </form>
        )}

        {/* Step 4 — Receive Inventory */}
        {currentStep === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Receive Inventory</h2>
            <p className="text-sm text-gray-500 mb-4">
              Landed unit cost includes this cycle&apos;s shipping, spread across the
              items it moved. Edit a value to override it.
            </p>

            {costingWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                {costingWarnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-800">
                    {w}
                  </p>
                ))}
              </div>
            )}

            {receiveItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">
                No purchase order items found.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="hidden sm:grid sm:grid-cols-12 gap-2 px-3 text-xs font-medium text-gray-500">
                  <div className="col-span-4">Product</div>
                  <div className="col-span-2 text-center">Ordered</div>
                  <div className="col-span-2 text-center">Received</div>
                  <div className="col-span-4 text-center">Landed Unit Cost (EGP)</div>
                </div>

                {receiveItems.map((item, idx) => {
                  const poItem = poItems.find((pi: any) => pi.id === item.purchaseOrderItemId);
                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-gray-50 rounded-lg p-3"
                    >
                      <div className="sm:col-span-4">
                        <span className="text-xs text-gray-400 sm:hidden">Product: </span>
                        <p className="text-sm font-medium text-gray-900">
                          {poItem?.product?.name ?? 'Product'}
                        </p>
                      </div>

                      <div className="sm:col-span-2 text-center">
                        <span className="text-xs text-gray-400 sm:hidden">Ordered: </span>
                        <span className="text-sm text-gray-600">{poItem?.orderedQty ?? 0}</span>
                      </div>

                      <div className="sm:col-span-2">
                        <span className="text-xs text-gray-400 sm:hidden">Received: </span>
                        <input
                          type="number"
                          placeholder="0"
                          value={item.receivedQty}
                          onChange={(e) =>
                            updateReceiveItem(idx, 'receivedQty', Number(e.target.value))
                          }
                          min="0"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <span className="text-xs text-gray-400 sm:hidden">Landed Unit Cost (EGP): </span>
                        <input
                          type="number"
                          placeholder="0"
                          step="0.01"
                          value={item.landedUnitCostEgp}
                          onChange={(e) =>
                            updateReceiveItem(
                              idx,
                              'landedUnitCostEgp',
                              Number(e.target.value),
                            )
                          }
                          min="0"
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
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
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                type="button"
                onClick={handleStep4Submit}
                disabled={isStep4Processing || receiveItems.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isStep4Processing && <Loader2 className="h-4 w-4 animate-spin" />}
                Complete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
