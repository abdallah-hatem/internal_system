import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { AssistantChat } from './assistant-chat';

/**
 * The office chat panel (owner 2026-10-20/25): a question goes to the API, the
 * answer comes back; a change comes back as a preview card and only its
 * Confirm button saves it — with the preview's own token and arguments.
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER',
  status: { configured: true, used: 3, limit: 100 } as Record<string, unknown>,
  posts: [] as { url: string; body: unknown }[],
  answer: null as unknown,
  confirmAnswer: { ok: true, summary: 'Recorded payment PAY-9.' } as unknown,
  fail: null as unknown,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'p@x.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: () => Promise.resolve({ data: { data: state.status } }),
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.fail) return Promise.reject(state.fail);
      return Promise.resolve({ data: { data: url.endsWith('/confirm') ? state.confirmAnswer : state.answer } });
    },
  },
}));

const PREVIEW = {
  tool: 'record_payment',
  args: { customer: 'Koshary', amount: 5000 },
  token: 'tok-1',
  expiresAt: null,
  summary: 'Koshary pays 5,000.00 EGP cash; owes 14,950.00 after.',
};

beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.status = { configured: true, used: 3, limit: 100 };
  state.posts = [];
  state.answer = { reply: 'You have 40 brake pads.', pending: [] };
  state.confirmAnswer = { ok: true, summary: 'Recorded payment PAY-9.' };
  state.fail = null;
});
afterEach(() => cleanup());

function show(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <AssistantChat />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function openAndAsk(text: string) {
  fireEvent.click(screen.getByTestId('assistant-chat-open'));
  const input = await screen.findByPlaceholderText(en.assistantChat.placeholder);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('assistant-chat-send'));
  });
}

describe('the chat panel', () => {
  it('a question and its answer; the day’s usage shown', async () => {
    show();
    await openAndAsk('How many brake pads?');
    expect(await screen.findByText('You have 40 brake pads.')).toBeTruthy();
    expect(screen.getByTestId('assistant-chat-user').textContent).toBe('How many brake pads?');
    expect(state.posts[0]).toEqual({ url: '/assistant/chat', body: { messages: [{ role: 'user', content: 'How many brake pads?' }] } });
    expect((await screen.findByTestId('assistant-chat-usage')).textContent).toContain('3 of 100');
  });

  it('the second question carries the conversation so far', async () => {
    show();
    await openAndAsk('How many brake pads?');
    await screen.findByText('You have 40 brake pads.');
    fireEvent.change(screen.getByPlaceholderText(en.assistantChat.placeholder), { target: { value: 'And chains?' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('assistant-chat-send'));
    });
    expect((state.posts[1].body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'How many brake pads?' },
      { role: 'assistant', content: 'You have 40 brake pads.' },
      { role: 'user', content: 'And chains?' },
    ]);
  });

  it('a change comes back as a preview; Confirm sends its own tool, arguments and token, once, and says it is saved', async () => {
    state.answer = { reply: 'This records 5,000 from Koshary. Press Confirm.', pending: [PREVIEW] };
    show();
    await openAndAsk('Koshary paid 5000 cash');
    const card = await screen.findByTestId('assistant-chat-preview');
    expect(card.textContent).toContain(PREVIEW.summary);
    await act(async () => {
      fireEvent.click(screen.getByTestId('assistant-chat-confirm'));
    });
    await waitFor(() => expect(screen.getByTestId('assistant-chat-preview').getAttribute('data-state')).toBe('saved'));
    const confirms = state.posts.filter((p) => p.url === '/assistant/chat/confirm');
    expect(confirms).toEqual([{ url: '/assistant/chat/confirm', body: { tool: PREVIEW.tool, args: PREVIEW.args, token: PREVIEW.token } }]);
    expect(screen.getByTestId('assistant-chat-outcome').textContent).toContain('Recorded payment PAY-9.');
    // No second Confirm to press.
    expect(screen.queryByTestId('assistant-chat-confirm')).toBeNull();
  });

  it('Cancel saves nothing and says so', async () => {
    state.answer = { reply: 'Press Confirm.', pending: [PREVIEW] };
    show();
    await openAndAsk('Koshary paid 5000');
    fireEvent.click(await screen.findByTestId('assistant-chat-cancel'));
    expect(state.posts.some((p) => p.url.endsWith('/confirm'))).toBe(false);
    expect(screen.getByTestId('assistant-chat-outcome').textContent).toBe(en.assistantChat.cancelled);
  });

  it('a refused confirm shows the reason, not "saved"', async () => {
    state.answer = { reply: 'Press Confirm.', pending: [PREVIEW] };
    state.confirmAnswer = { ok: false, summary: 'CONFIRMATION_EXPIRED: This confirmation has expired.' };
    show();
    await openAndAsk('Koshary paid 5000');
    await act(async () => {
      fireEvent.click(await screen.findByTestId('assistant-chat-confirm'));
    });
    await waitFor(() => expect(screen.getByTestId('assistant-chat-preview').getAttribute('data-state')).toBe('failed'));
    expect(screen.getByTestId('assistant-chat-outcome').textContent).toContain('expired');
  });

  it('the day used up: the API’s reason, in the reader’s words', async () => {
    state.fail = { isAxiosError: true, response: { status: 429, data: { error: { code: 'AI_DAILY_LIMIT', message: 'used up', params: { limit: 100 } } } } };
    show();
    await openAndAsk('Hi');
    expect((await screen.findByTestId('assistant-chat-problem')).textContent).toBe(en.errors.AI_DAILY_LIMIT.replace('{limit}', '100'));
  });

  it('no key on the API: it says the chat is not set up, and nothing can be sent', async () => {
    state.status = { configured: false, used: 0, limit: 100 };
    show();
    fireEvent.click(screen.getByTestId('assistant-chat-open'));
    expect(await screen.findByTestId('assistant-chat-not-set-up')).toBeTruthy();
    expect((screen.getByPlaceholderText(en.assistantChat.placeholder) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('only for core partners: anyone else sees no chat button', () => {
    state.role = 'ADMIN_SUPPORT';
    show();
    expect(screen.queryByTestId('assistant-chat-open')).toBeNull();
  });

  it('in Arabic: translated, and the send arrow mirrors', async () => {
    show('ar');
    fireEvent.click(screen.getByTestId('assistant-chat-open'));
    expect(await screen.findByPlaceholderText(ar.assistantChat.placeholder)).toBeTruthy();
    expect(screen.getByTestId('assistant-chat-send').innerHTML).toContain('rtl:-scale-x-100');
  });
});
