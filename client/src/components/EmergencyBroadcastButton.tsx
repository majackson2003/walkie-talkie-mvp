import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type EmergencyBroadcastButtonProps = {
  onConfirm: () => void;
  isSending: boolean;
  cooldownMs: number;
  disabled?: boolean;
  error?: string | null;
  confirmWindowMs?: number;
};

const DEFAULT_CONFIRM_WINDOW_MS = 4_000;

const formatSeconds = (value: number) => {
  const seconds = Math.max(0, Math.ceil(value / 1000));
  return `${seconds}s`;
};

const vibrate = (pattern: number | number[]) => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
};

export const EmergencyBroadcastButton = ({
  onConfirm,
  isSending,
  cooldownMs,
  disabled = false,
  error,
  confirmWindowMs = DEFAULT_CONFIRM_WINDOW_MS,
}: EmergencyBroadcastButtonProps) => {
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmRemaining, setConfirmRemaining] = useState(confirmWindowMs);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isCoolingDown = cooldownMs > 0;
  const isInteractive = !disabled && !isSending && !isCoolingDown;

  const clearConfirmTimers = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    if (confirmIntervalRef.current) {
      clearInterval(confirmIntervalRef.current);
      confirmIntervalRef.current = null;
    }
  };

  const resetConfirm = useCallback(() => {
    clearConfirmTimers();
    setIsConfirming(false);
    setConfirmRemaining(confirmWindowMs);
  }, [confirmWindowMs]);

  useEffect(() => {
    if (!isConfirming) {
      return;
    }
    confirmIntervalRef.current = setInterval(() => {
      setConfirmRemaining((prev) => Math.max(0, prev - 250));
    }, 250);
    confirmTimeoutRef.current = setTimeout(() => {
      resetConfirm();
    }, confirmWindowMs);
    return () => {
      clearConfirmTimers();
    };
  }, [confirmWindowMs, isConfirming, resetConfirm]);

  useEffect(() => {
    if (!isInteractive && isConfirming) {
      resetConfirm();
    }
  }, [isConfirming, isInteractive, resetConfirm]);

  const handlePress = useCallback(() => {
    if (!isInteractive) {
      return;
    }
    if (!isConfirming) {
      setIsConfirming(true);
      setConfirmRemaining(confirmWindowMs);
      vibrate(12);
      return;
    }
    resetConfirm();
    vibrate([12, 24, 12]);
    onConfirm();
  }, [confirmWindowMs, isConfirming, isInteractive, onConfirm, resetConfirm]);

  const label = useMemo(() => {
    if (isSending) {
      return 'Sending Emergency...';
    }
    if (isConfirming) {
      return `Tap again to confirm (${formatSeconds(confirmRemaining)})`;
    }
    if (isCoolingDown) {
      return `Available in ${formatSeconds(cooldownMs)}`;
    }
    return 'Emergency Broadcast';
  }, [confirmRemaining, cooldownMs, isConfirming, isCoolingDown, isSending]);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <button
        type="button"
        aria-pressed={isConfirming}
        aria-busy={isSending}
        onClick={handlePress}
        disabled={!isInteractive}
        className={`w-full max-w-xs rounded-2xl border-2 px-6 py-5 text-center text-base font-semibold uppercase tracking-wide transition ${
          isConfirming
            ? 'border-red-400 bg-red-700 text-white shadow-[0_0_24px_rgba(248,113,113,0.5)]'
            : 'border-red-500 bg-red-600 text-white shadow-[0_0_18px_rgba(248,113,113,0.35)]'
        } ${!isInteractive ? 'opacity-60' : 'active:scale-[0.98]'}`}
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <span>{label}</span>
            <span className="rounded-full bg-red-900/50 px-2 py-1 text-xs font-semibold text-red-100">
              URGENT
            </span>
          </div>
          <span className="text-xs font-medium text-white/80">
            Press twice to send a global alert
          </span>
        </div>
      </button>

      {error ? (
        <p className="max-w-xs text-center text-sm text-red-300">{error}</p>
      ) : null}
    </div>
  );
};
