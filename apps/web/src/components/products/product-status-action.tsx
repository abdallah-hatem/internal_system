'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Power, PowerOff } from 'lucide-react';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { isOffered } from '@/lib/product-status';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Deactivate / Reactivate a product, after a short confirm that says what it
 * does (BUSINESS_LOGIC §3, DECIDED 2026-10-14). One definition, rendered on
 * the product page (`look="button"`) and in each row of the products list
 * (`look="icon"` on a wide screen, `look="text"` on a phone card).
 *
 * Only a core partner sees it — `PUT /products/:id/status` carries
 * @Roles('CORE_PARTNER'). The dialog portals to the body, so it never sits
 * inside a row's or a form's markup.
 */
export function ProductStatusAction({
  product,
  look,
}: {
  product: { id: string; name: string; status?: string | null };
  look: 'button' | 'icon' | 'text';
}) {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const may = useCan('product.setStatus');
  const [open, setOpen] = useState(false);

  const active = isOffered(product);
  const next = active ? 'INACTIVE' : 'ACTIVE';
  const label = active ? t('deactivate') : t('reactivate');

  const change = useMutation({
    mutationFn: () => api.put(`/products/${product.id}/status`, { status: next }),
    onSuccess: async () => {
      // Every picker reads ['products'], so a switched-off product leaves
      // them (and a reactivated one returns) without a reload.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['product', product.id] }),
      ]);
      setOpen(false);
      toast(active ? t('deactivated', { name: product.name }) : t('reactivated', { name: product.name }), 'success');
    },
    onError: (error: unknown) => toast(apiError(error, t('statusChangeFailed')), 'error'),
  });

  if (!may) return null;

  const Icon = active ? PowerOff : Power;
  const trigger =
    look === 'icon' ? (
      <button
        type="button"
        data-testid="status-action"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        className={`p-1.5 rounded-lg transition-colors cursor-pointer text-muted-foreground ${
          active ? 'hover:text-destructive hover:bg-destructive/10' : 'hover:text-success hover:bg-success/10'
        }`}
      >
        <Icon className="h-4 w-4" />
      </button>
    ) : look === 'text' ? (
      <button
        type="button"
        data-testid="status-action"
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1 text-xs text-muted-foreground px-2 py-1 rounded cursor-pointer ${
          active ? 'hover:text-destructive' : 'hover:text-success'
        }`}
      >
        <Icon className="h-3.5 w-3.5" /> {label}
      </button>
    ) : (
      <Button
        type="button"
        variant="outline"
        data-testid="status-action"
        onClick={() => setOpen(true)}
        className={`min-h-11 sm:min-h-9 rounded-lg ${active ? 'text-destructive hover:text-destructive' : 'text-success hover:text-success'}`}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </Button>
    );

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={(o) => !change.isPending && setOpen(o)}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader className="text-start sm:text-start">
            <DialogTitle>
              {active ? t('deactivateTitle', { name: product.name }) : t('reactivateTitle', { name: product.name })}
            </DialogTitle>
            <DialogDescription>{active ? t('deactivateBody') : t('reactivateBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={change.isPending}
              className="min-h-11 rounded-lg text-muted-foreground"
            >
              {tc('cancel')}
            </Button>
            <Button
              type="button"
              variant={active ? 'destructive' : 'default'}
              onClick={() => change.mutate()}
              disabled={change.isPending}
              className="min-h-11 rounded-lg"
            >
              {change.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
