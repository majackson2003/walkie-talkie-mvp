import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyBroadcast } from '@walkie/shared/types';
import type { SocketService } from '../services/socketService';

type EmergencyBroadcastPayload = {
  message: string;
};

type EmergencyAlertPayload = {
  broadcast: EmergencyBroadcast;
};

type EmergencyErrorPayload = {
  error: string;
  code: string;
  retryAfterMs?: number;
};

type UseEmergencyBroadcastOptions = {
  socketService: SocketService;
  playSosTone: () => void;
  interruptAudio: () => void;
  onBroadcastReceived?: (broadcast: EmergencyBroadcast) => void;
};

type UseEmergencyBroadcastState = {
  sendEmergency: (message: string) => Promise<void>;
  isSending: boolean;
  error: string | null;
  cooldownMs: number;
  lastBroadcastAt: Date | null;
};

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const MIN_MESSAGE_LENGTH = 1;
const MAX_MESSAGE_LENGTH = 200;

const normalizeMessage = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH || trimmed.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  return trimmed;
};

export const useEmergencyBroadcast = ({
  socketService,
  playSosTone,
  interruptAudio,
  onBroadcastReceived,
}: UseEmergencyBroadcastOptions): UseEmergencyBroadcastState => {
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [lastBroadcastAt, setLastBroadcastAt] = useState<Date | null>(null);
  const lastBroadcastRef = useRef<number | null>(null);

  const updateCooldown = useCallback(() => {
    if (!lastBroadcastRef.current) {
      setCooldownMs(0);
      return;
    }
    const elapsed = Date.now() - lastBroadcastRef.current;
    const remaining = Math.max(0, RATE_LIMIT_WINDOW_MS - elapsed);
    setCooldownMs(remaining);
  }, []);

  const setLastSentNow = useCallback(() => {
    const now = Date.now();
    lastBroadcastRef.current = now;
    setLastBroadcastAt(new Date(now));
    updateCooldown();
  }, [updateCooldown]);

  const sendEmergency = useCallback(
    async (message: string) => {
      setError(null);
      if (socketService.getStatus() !== 'connected') {
        setError('Offline. Connect to send emergency broadcast.');
        return;
      }
      const normalized = normalizeMessage(message);
      if (!normalized) {
        setError('Message must be 1-200 characters.');
        return;
      }

      if (lastBroadcastRef.current) {
        const elapsed = Date.now() - lastBroadcastRef.current;
        const remaining = Math.max(0, RATE_LIMIT_WINDOW_MS - elapsed);
        setCooldownMs(remaining);
        if (remaining > 0) {
          setError(`Rate limited. Try again in ${Math.ceil(remaining / 1000)}s.`);
          return;
        }
      } else {
        setCooldownMs(0);
      }

      setIsSending(true);
      try {
        const response = await socketService.request<{ broadcast: EmergencyBroadcast }>(
          'emergency:broadcast',
          { message: normalized } satisfies EmergencyBroadcastPayload,
        );

        if (!response.ok) {
          if (response.code === 'rate_limited') {
            const retryAfterMs = response.retryAfterMs;
            if (retryAfterMs > 0) {
              lastBroadcastRef.current = Date.now() - (RATE_LIMIT_WINDOW_MS - retryAfterMs);
              updateCooldown();
            }
          }
          setError(response.error);
          console.warn('[emergency] broadcast failed', response);
          return;
        }

        setLastSentNow();
        console.warn('[emergency] broadcast sent', response.data.broadcast);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : 'Unable to send emergency broadcast.';
        setError(messageText);
        console.warn('[emergency] broadcast error', err);
      } finally {
        setIsSending(false);
      }
    },
    [setLastSentNow, socketService, updateCooldown],
  );

  useEffect(() => {
    const unsubscribeAlert = socketService.on<[EmergencyAlertPayload]>('emergency:alert', (payload) => {
      if (!payload || !payload.broadcast) {
        return;
      }
      const broadcast = payload.broadcast;
      console.warn('[emergency] received', broadcast);
      interruptAudio();
      playSosTone();
      onBroadcastReceived?.(broadcast);
    });

    const unsubscribeError = socketService.on<[EmergencyErrorPayload]>('emergency:error', (payload) => {
      if (!payload?.error) {
        return;
      }
      setError(payload.error);
    });

    return () => {
      unsubscribeAlert();
      unsubscribeError();
    };
  }, [interruptAudio, onBroadcastReceived, playSosTone, socketService]);

  useEffect(() => {
    if (cooldownMs <= 0) {
      return;
    }
    const timer = setInterval(updateCooldown, 1000);
    return () => clearInterval(timer);
  }, [cooldownMs, updateCooldown]);

  return useMemo(
    () => ({
      sendEmergency,
      isSending,
      error,
      cooldownMs,
      lastBroadcastAt,
    }),
    [cooldownMs, error, isSending, lastBroadcastAt, sendEmergency],
  );
};
