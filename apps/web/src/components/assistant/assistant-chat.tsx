'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle, Loader2, Send, X } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { cn } from '@/lib/utils';

/**
 * The office chat (owner 2026-10-20, built 2026-10-25): ask the assistant, or
 * tell it what happened, from any page. The answers come from the assistant's
 * own tools on the API (`assistant/chat`); a change comes back as a preview
 * card, and only its Confirm button saves it.
 *
 * The conversation lives here, in memory, for as long as the app is open —
 * nothing of it is stored (the owner: no conversation kept beyond the audit log).
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Pending {
  tool: string;
  args: Record<string, unknown>;
  token: string;
  expiresAt: string | null;
  summary: string;
}

/** What the panel shows: a turn, or a preview waiting for the partner. */
type Entry =
  | { kind: 'turn'; turn: Turn }
  | { kind: 'pending'; id: string; pending: Pending; state: 'open' | 'saving' | 'saved' | 'cancelled' | 'failed'; result?: string };

interface Status {
  configured: boolean;
  used: number;
  limit: number;
}

const rows = <T,>(r: { data: { data?: unknown } }) => (r.data.data ?? r.data) as T;

export function AssistantChat() {
  const t = useTranslations('assistantChat');
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const allowed = useCan('assistant.chat');
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const status = useQuery({
    queryKey: ['assistant-chat', 'status'],
    queryFn: () => api.get('/assistant/chat/status').then(rows<Status>),
    enabled: allowed && open,
  });

  // The newest message stays in view.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const turns = (list: Entry[]) => list.filter((e): e is Extract<Entry, { kind: 'turn' }> => e.kind === 'turn').map((e) => e.turn);

  const ask = useMutation({
    mutationFn: (messages: Turn[]) =>
      api.post('/assistant/chat', { messages }).then(rows<{ reply: string; pending: Pending[] }>),
    onSuccess: (data) => {
      setEntries((list) => [
        ...list,
        ...(data.reply ? [{ kind: 'turn' as const, turn: { role: 'assistant' as const, content: data.reply } }] : []),
        ...data.pending.map((pending, i) => ({
          kind: 'pending' as const,
          id: `${Date.now()}-${i}`,
          pending,
          state: 'open' as const,
        })),
      ]);
      void queryClient.invalidateQueries({ queryKey: ['assistant-chat', 'status'] });
    },
    onError: (err) => setProblem(apiError(err, t('failed'))),
  });

  const confirm = useMutation({
    mutationFn: ({ pending }: { id: string; pending: Pending }) =>
      api
        .post('/assistant/chat/confirm', { tool: pending.tool, args: pending.args, token: pending.token })
        .then(rows<{ ok: boolean; summary: string }>),
    onMutate: ({ id }) => setState(id, 'saving'),
    onSuccess: (data, { id }) => {
      setState(id, data.ok ? 'saved' : 'failed', data.summary);
      // Something changed: every list on screen reads it again.
      if (data.ok) void queryClient.invalidateQueries();
    },
    onError: (err, { id }) => setState(id, 'failed', apiError(err, t('failed'))),
  });

  function setState(id: string, state: Extract<Entry, { kind: 'pending' }>['state'], result?: string) {
    setEntries((list) => list.map((e) => (e.kind === 'pending' && e.id === id ? { ...e, state, result } : e)));
  }

  function send() {
    const content = draft.trim();
    if (!content || ask.isPending) return;
    setProblem(null);
    const next: Entry[] = [...entries, { kind: 'turn', turn: { role: 'user', content } }];
    setEntries(next);
    setDraft('');
    ask.mutate(turns(next));
  }

  if (!allowed) return null;

  const notSetUp = status.data && !status.data.configured;
  const usedUp = status.data && status.data.used >= status.data.limit;

  return (
    <>
      {!open && (
        <button
          type="button"
          data-testid="assistant-chat-open"
          onClick={() => {
            setOpen(true);
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
          aria-label={t('open')}
          title={t('open')}
          className="fixed end-4 bottom-[calc(5rem+var(--phone-bar-inset))] z-40 inline-flex size-12 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:end-6 md:bottom-6 print:hidden"
        >
          <Bot className="size-6" />
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label={t('title')}
          data-testid="assistant-chat"
          className="fixed inset-x-0 bottom-0 top-14 z-50 flex flex-col border-t border-border bg-card shadow-2xl md:inset-x-auto md:end-6 md:bottom-6 md:top-auto md:h-[min(36rem,calc(100vh-6rem))] md:w-[26rem] md:rounded-2xl md:border print:hidden"
        >
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
                <Bot className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
                {status.data?.configured && (
                  <p data-testid="assistant-chat-usage" className="text-xs text-muted-foreground">
                    {t('usage', { used: status.data.used, limit: status.data.limit })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {entries.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setEntries([]);
                    setProblem(null);
                  }}
                  className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('newChat')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('close')}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </header>

          <div ref={listRef} className="scrollbar-clean flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="assistant-chat-messages">
            {notSetUp ? (
              <p data-testid="assistant-chat-not-set-up" className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                {t('notSetUp')}
              </p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('intro')}</p>
            ) : null}

            {entries.map((e, i) =>
              e.kind === 'turn' ? (
                <div
                  key={i}
                  data-testid={`assistant-chat-${e.turn.role}`}
                  dir="auto"
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm',
                    e.turn.role === 'user'
                      ? 'ms-auto bg-primary text-primary-foreground'
                      : 'me-auto bg-muted text-foreground',
                  )}
                >
                  {e.turn.content}
                </div>
              ) : (
                <div key={e.id} data-testid="assistant-chat-preview" data-state={e.state} className="rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">{t('previewTitle')}</p>
                  {/* The tools write their previews in English (as for the MCP
                      surface), so the lines and amounts read left to right
                      even on an Arabic screen. */}
                  <p dir="ltr" className="whitespace-pre-wrap break-words text-start text-foreground">{e.pending.summary}</p>
                  {e.state === 'open' || e.state === 'saving' ? (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        data-testid="assistant-chat-confirm"
                        disabled={e.state === 'saving'}
                        onClick={() => confirm.mutate({ id: e.id, pending: e.pending })}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {e.state === 'saving' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle className="size-4" />}
                        {t('confirm')}
                      </button>
                      <button
                        type="button"
                        data-testid="assistant-chat-cancel"
                        disabled={e.state === 'saving'}
                        onClick={() => setState(e.id, 'cancelled')}
                        className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('cancel')}
                      </button>
                    </div>
                  ) : (
                    <p
                      data-testid="assistant-chat-outcome"
                      dir="auto"
                      className={cn(
                        'mt-2 whitespace-pre-wrap text-sm font-medium',
                        e.state === 'saved' ? 'text-success' : e.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {e.state === 'saved' ? `${t('saved')} — ${e.result ?? ''}` : e.state === 'failed' ? t('notSaved', { reason: e.result ?? '' }) : t('cancelled')}
                    </p>
                  )}
                </div>
              ),
            )}

            {ask.isPending && (
              <div data-testid="assistant-chat-thinking" className="me-auto flex w-14 items-center justify-center gap-1 rounded-2xl bg-muted px-3 py-3" aria-label={t('thinking')}>
                {[0, 1, 2].map((d) => (
                  <span key={d} className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse" style={{ animationDelay: `${d * 150}ms` }} />
                ))}
              </div>
            )}
            {problem && (
              <p role="alert" data-testid="assistant-chat-problem" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>

          <form
            className="flex items-end gap-2 border-t border-border p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] md:pb-3"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor="assistant-chat-input" className="sr-only">{t('placeholder')}</label>
            <textarea
              id="assistant-chat-input"
              ref={inputRef}
              rows={1}
              value={draft}
              maxLength={2000}
              disabled={!!notSetUp || !!usedUp}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={usedUp ? t('usedUp') : t('placeholder')}
              dir="auto"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
            />
            <button
              type="submit"
              data-testid="assistant-chat-send"
              disabled={!draft.trim() || ask.isPending || !!notSetUp || !!usedUp}
              aria-label={t('send')}
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="size-5 rtl:-scale-x-100" />
            </button>
          </form>
        </section>
      )}
    </>
  );
}
