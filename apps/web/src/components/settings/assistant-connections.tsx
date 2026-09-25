'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Unplug } from 'lucide-react';

import { api, MCP_SERVER_URL } from '../../lib/api';
import { useApiError } from '../../lib/api-error';
import { formatDate } from '../../lib/dates';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/** One Claude app the partner has signed in, as the API lists it. */
interface Connection {
  /** The OAuth client's id: what DELETE takes. */
  id: string;
  clientName: string | null;
  connectedAt: string;
  lastRefreshedAt: string | null;
}

const CONNECTIONS_KEY = ['assistant-connections'];

/**
 * Settings → Claude connections (BUSINESS_LOGIC §16).
 *
 * Each Claude app a partner signs in — the phone, a laptop — is its own
 * connection, so each can be ended alone: a lost phone is disconnected without
 * touching the laptop and without a password change. Disconnect all asks first,
 * because it ends every app at once and each then has to be signed in again.
 *
 * Core partners only — the API refuses anyone else — so the page renders this
 * for them alone rather than showing a section that can only fail.
 *
 * The list is re-fetched after every disconnect, success or not. A 404 means
 * the app was already gone (disconnected on another tab, or lapsed), and the
 * list catching up is the right answer to that too.
 */
export function AssistantConnections() {
  const t = useTranslations('claudeConnections');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmingAll, setConfirmingAll] = useState(false);

  const { data: connections, isLoading, isError } = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () =>
      api.get('/auth/assistant-connections').then((r) => r.data.data as Connection[]),
  });

  const nameOf = (c: Connection) => c.clientName || t('unnamed');
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });

  const disconnectOne = useMutation({
    mutationFn: (c: Connection) => api.delete(`/auth/assistant-connections/${c.id}`),
    onSuccess: (_res, c) => toast.success(t('disconnected', { name: nameOf(c) })),
    onError: (err) => toast.error(apiError(err, t('failed'))),
    onSettled: refresh,
  });

  const disconnectAll = useMutation({
    mutationFn: () => api.delete('/auth/assistant-connections'),
    onSuccess: () => {
      setConfirmingAll(false);
      toast.success(t('allDisconnected'));
    },
    onError: (err) => toast.error(apiError(err, t('failed'))),
    onSettled: refresh,
  });

  const list = connections ?? [];
  const busy = disconnectOne.isPending || disconnectAll.isPending;

  return (
    <section
      className="bg-card rounded-xl border border-border p-6"
      data-testid="claude-connections"
      aria-labelledby="claude-connections-title"
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2
          id="claude-connections-title"
          className="text-lg font-semibold text-foreground flex items-center gap-2"
        >
          <Bot className="h-5 w-5 text-muted-foreground" aria-hidden />
          {t('title')}
        </h2>
        {list.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmingAll(true)}
            disabled={busy}
            className="min-h-11 rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {t('disconnectAll')}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">{t('intro')}</p>

      {isLoading ? (
        <div className="space-y-3" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="h-16 rounded-lg animate-pulse bg-muted" />
          ))}
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t('loadFailed')}
        </p>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">{t('empty')}</p>
          <p className="text-sm text-muted-foreground">{t('howTo')}</p>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">{t('serverUrl')}</p>
            {/* A URL reads left to right in both languages. */}
            <code
              dir="ltr"
              className="block rounded-lg bg-muted border border-border px-3 py-2 text-sm text-foreground break-all select-all text-start"
            >
              {MCP_SERVER_URL}
            </code>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((c) => {
            const ending = disconnectOne.isPending && disconnectOne.variables?.id === c.id;
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground break-words">{nameOf(c)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('connected', { date: formatDate(c.connectedAt, { includeTime: true }) })}
                    {' · '}
                    {c.lastRefreshedAt
                      ? t('lastRefreshed', {
                          date: formatDate(c.lastRefreshedAt, { includeTime: true }),
                        })
                      : t('neverRefreshed')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => disconnectOne.mutate(c)}
                  disabled={busy}
                  aria-label={t('disconnectOne', { name: nameOf(c) })}
                  className="min-h-11 rounded-lg"
                >
                  {ending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Unplug className="h-4 w-4" aria-hidden />
                  )}
                  {t('disconnect')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={confirmingAll}
        onOpenChange={(open) => !disconnectAll.isPending && setConfirmingAll(open)}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader className="text-start sm:text-start">
            <DialogTitle>{t('confirmAllTitle')}</DialogTitle>
            <DialogDescription>{t('confirmAll')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmingAll(false)}
              disabled={disconnectAll.isPending}
              className="min-h-11 rounded-lg text-muted-foreground"
            >
              {tc('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => disconnectAll.mutate()}
              disabled={disconnectAll.isPending}
              className="min-h-11 rounded-lg"
            >
              {disconnectAll.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('disconnectAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
