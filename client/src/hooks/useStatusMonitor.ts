import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SocketService } from '../services/socketService';

export type ConnectionQuality = 'good' | 'ok' | 'poor' | 'offline';
export type UserPresence = 'active' | 'idle' | 'away';

type BatteryState = {
  supported: boolean;
  charging: boolean;
  level: number;
  lowPowerMode: boolean;
};

type BatteryManagerLike = {
  charging: boolean;
  level: number;
  addEventListener: (type: 'chargingchange' | 'levelchange', listener: () => void) => void;
  removeEventListener: (type: 'chargingchange' | 'levelchange', listener: () => void) => void;
};

type OfflineQueueState = {
  queuedCount: number;
  state: 'idle' | 'queued' | 'offline';
};

type StatusMonitorState = {
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  connectionQuality: ConnectionQuality;
  latencyMs: number | null;
  battery: BatteryState;
  userStatus: UserPresence;
  offlineQueue: OfflineQueueState;
};

type StatusMonitorOptions = {
  socketService: SocketService;
  idleAfterMs?: number;
  awayAfterMs?: number;
};

const DEFAULT_IDLE_AFTER_MS = 60_000;
const DEFAULT_AWAY_AFTER_MS = 5 * 60_000;
const BASE_TICK_MS = 10_000;
const LOW_POWER_TICK_MS = 30_000;

const createBatteryState = (): BatteryState => ({
  supported: false,
  charging: true,
  level: 1,
  lowPowerMode: false,
});

const computeLowPower = (charging: boolean, level: number) => !charging && level <= 0.2;

export const useStatusMonitor = ({
  socketService,
  idleAfterMs = DEFAULT_IDLE_AFTER_MS,
  awayAfterMs = DEFAULT_AWAY_AFTER_MS,
}: StatusMonitorOptions): StatusMonitorState => {
  const [connectionStatus, setConnectionStatus] = useState(socketService.getStatus());
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('offline');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [battery, setBattery] = useState<BatteryState>(createBatteryState);
  const [userStatus, setUserStatus] = useState<UserPresence>('active');
  const [offlineQueue, setOfflineQueue] = useState<OfflineQueueState>({
    queuedCount: socketService.getQueuedCount(),
    state: 'idle',
  });

  const lastActivityRef = useRef(Date.now());
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  const updatePresence = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastActivityRef.current;
    const nextStatus: UserPresence =
      elapsed >= awayAfterMs ? 'away' : elapsed >= idleAfterMs ? 'idle' : 'active';
    setUserStatus(nextStatus);
  }, [awayAfterMs, idleAfterMs]);

  const updateQueueState = useCallback(() => {
    const queuedCount = socketService.getQueuedCount();
    const status = socketService.getStatus();
    const state =
      status !== 'connected' ? 'offline' : queuedCount > 0 ? 'queued' : 'idle';
    setOfflineQueue({ queuedCount, state });
  }, [socketService]);

  const updateConnectionStatus = useCallback(() => {
    setConnectionStatus(socketService.getStatus());
  }, [socketService]);

  const updateTick = useCallback(() => {
    updatePresence();
    updateQueueState();
    updateConnectionStatus();
  }, [updatePresence, updateQueueState, updateConnectionStatus]);

  const handleActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setUserStatus('active');
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribeQuality = socketService.onConnectionQuality((payload) => {
      setConnectionQuality(payload.quality);
      setLatencyMs(payload.latencyMs);
    });

    const unsubscribeConnect = socketService.on('connect', () => {
      setConnectionStatus('connected');
      setConnectionQuality((prev) => (prev === 'offline' ? 'ok' : prev));
      updateQueueState();
    });

    const unsubscribeDisconnect = socketService.on('disconnect', () => {
      setConnectionStatus('disconnected');
      setConnectionQuality('offline');
    });

    return () => {
      unsubscribeQuality();
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [socketService, updateQueueState]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleActivity();
      }
    };
    const handleOnline = () => updateQueueState();

    window.addEventListener('pointerdown', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('focus', handleActivity);
    window.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOnline);

    return () => {
      window.removeEventListener('pointerdown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('focus', handleActivity);
      window.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOnline);
    };
  }, [handleActivity, updateQueueState]);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }
    let batteryManager: BatteryManagerLike | null = null;
    let cleanup: (() => void) | null = null;

    const attachBattery = async () => {
      if (typeof navigator === 'undefined' || !('getBattery' in navigator)) {
        return;
      }
      try {
        batteryManager = await (navigator as Navigator & {
          getBattery: () => Promise<BatteryManagerLike>;
        }).getBattery();
      } catch {
        return;
      }
      if (!batteryManager || !isMountedRef.current) {
        return;
      }

      const updateBattery = () => {
        if (!batteryManager) {
          return;
        }
        const charging = batteryManager.charging;
        const level = batteryManager.level;
        const lowPowerMode = computeLowPower(charging, level);
        setBattery({
          supported: true,
          charging,
          level,
          lowPowerMode,
        });
      };

      updateBattery();
      const onChange = () => updateBattery();
      batteryManager.addEventListener('chargingchange', onChange);
      batteryManager.addEventListener('levelchange', onChange);
      cleanup = () => {
        batteryManager?.removeEventListener('chargingchange', onChange);
        batteryManager?.removeEventListener('levelchange', onChange);
      };
    };

    void attachBattery();
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
    }
    const tickInterval = battery.lowPowerMode ? LOW_POWER_TICK_MS : BASE_TICK_MS;
    tickTimerRef.current = setInterval(updateTick, tickInterval);
    updateTick();
    return () => {
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [battery.lowPowerMode, updateTick]);

  return useMemo(
    () => ({
      connectionStatus,
      connectionQuality,
      latencyMs,
      battery,
      userStatus,
      offlineQueue,
    }),
    [battery, connectionQuality, connectionStatus, latencyMs, offlineQueue, userStatus],
  );
};
