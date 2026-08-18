'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (type: ToastType, message: string) => void;
  removeToast: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Styling maps
// ---------------------------------------------------------------------------

const toastConfig: Record<
  ToastType,
  { container: string; iconColor: string; Icon: typeof CheckCircle }
> = {
  success: {
    container: 'bg-green-50 border-green-200 text-green-800',
    iconColor: 'text-green-500',
    Icon: CheckCircle,
  },
  error: {
    container: 'bg-red-50 border-red-200 text-red-800',
    iconColor: 'text-red-500',
    Icon: XCircle,
  },
  warning: {
    container: 'bg-amber-50 border-amber-200 text-amber-800',
    iconColor: 'text-amber-500',
    Icon: AlertTriangle,
  },
  info: {
    container: 'bg-blue-50 border-blue-200 text-blue-800',
    iconColor: 'text-blue-500',
    Icon: Info,
  },
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const DISMISS_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idCounter = useRef(0);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (type: ToastType, message: string) => {
      const id = `toast-${++idCounter.current}`;
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => removeToast(id), DISMISS_MS);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}

      {/* Toast container – fixed top-right */}
      <div className="fixed top-4 end-4 z-[100] flex flex-col gap-3 pointer-events-none max-w-sm w-full">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Individual toast
// ---------------------------------------------------------------------------

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const { container, iconColor, Icon } = toastConfig[toast.type];

  return (
    <div
      role="alert"
      className={`
        pointer-events-auto flex items-start gap-3 w-full px-4 py-3
        border rounded-lg shadow-lg toast-slide-in
        ${container}
      `}
    >
      <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${iconColor}`} />
      <p className="flex-1 text-sm font-medium">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="flex-shrink-0 p-0.5 rounded hover:bg-black/5 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseToastReturn {
  /** The imperative toast function (callable directly: `toast("msg", "error")`) */
  toast: ((message: string, type?: ToastType) => void) & {
    success: (message: string) => void;
    error: (message: string) => void;
    warning: (message: string) => void;
    info: (message: string) => void;
  };
  /** Shorthand methods for backward compat (e.g. `const { error } = useToast()`) */
  success: (message: string) => void;
  error: (message: string) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
  /** Alias for backward compat */
  addToast: (message: string, type?: ToastType) => void;
  /** Raw state */
  toasts: Toast[];
  removeToast: (id: string) => void;
}

export function useToast(): UseToastReturn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');

  const imperative = Object.assign(
    (message: string, type: ToastType = 'error') => ctx.addToast(type, message),
    {
      success: (message: string) => ctx.addToast('success', message),
      error: (message: string) => ctx.addToast('error', message),
      warning: (message: string) => ctx.addToast('warning', message),
      info: (message: string) => ctx.addToast('info', message),
    },
  );

  return {
    toast: imperative,
    success: (message: string) => ctx.addToast('success', message),
    error: (message: string) => ctx.addToast('error', message),
    warning: (message: string) => ctx.addToast('warning', message),
    info: (message: string) => ctx.addToast('info', message),
    addToast: (message: string, type: ToastType = 'error') =>
      ctx.addToast(type, message),
    toasts: ctx.toasts,
    removeToast: ctx.removeToast,
  };
}

// ---------------------------------------------------------------------------
// Imperative API (works outside React components, e.g. onError callbacks)
// ---------------------------------------------------------------------------

let _addToast: ((type: ToastType, message: string) => void) | null = null;

/** Bridge component – renders inside the provider to wire up the imperative API. */
export function ToastBridge() {
  const ctx = useContext(ToastContext);

  useEffect(() => {
    if (ctx) {
      _addToast = ctx.addToast;
      return () => {
        _addToast = null;
      };
    }
  }, [ctx]);

  return null;
}

/**
 * Imperative toast object – safe to call from any module.
 *
 * @example
 * import { toast } from '@/components/ui/toast';
 *
 * // Inside a React Query onError callback:
 * onError: (err) => {
 *   toast.error(err.message ?? 'Something went wrong');
 * },
 */
export const toast = {
  success: (message: string) => _addToast?.('success', message),
  error: (message: string) => _addToast?.('error', message),
  warning: (message: string) => _addToast?.('warning', message),
  info: (message: string) => _addToast?.('info', message),
};
