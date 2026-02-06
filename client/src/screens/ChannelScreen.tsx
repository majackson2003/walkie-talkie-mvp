import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyBroadcast } from '@walkie/shared/types';
import { PushToTalkButton } from '../components/PushToTalkButton';
import { EmergencyBroadcastButton } from '../components/EmergencyBroadcastButton';
import { StatusBar, type BatteryInfo } from '../components/StatusBar';
import { UserList, type UserSummary } from '../components/UserList';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useEmergencyBroadcast } from '../hooks/useEmergencyBroadcast';
import type {
  AudioMessageEvent,
  SendAudioMessagePayload,
  SocketService,
} from '../services/socketService';
import { normalizeAudioMime } from '../utils/audioMime';

type ChannelScreenProps = {
  socketService: SocketService;
  channelCode: string;
  nickname: string;
};

type ConnectionQuality = 'good' | 'ok' | 'poor' | 'offline';
type UserPresence = 'active' | 'idle' | 'away';

type ConnectionState = {
  status: 'connected' | 'connecting' | 'disconnected';
  quality: ConnectionQuality;
  latencyMs: number | null;
  queueState: 'idle' | 'queued' | 'offline';
  queuedCount: number;
};

type BatteryManagerLike = {
  charging: boolean;
  level: number;
  addEventListener: (type: 'chargingchange' | 'levelchange', listener: () => void) => void;
  removeEventListener: (type: 'chargingchange' | 'levelchange', listener: () => void) => void;
};

type AudioHistoryPayload = {
  messages: AudioMessageEvent[];
};

const MIN_TICK_MS = 10_000;
const LOW_POWER_TICK_MS = 30_000;
const IDLE_AFTER_MS = 60_000;
const AWAY_AFTER_MS = 5 * 60_000;

const computeLowPower = (charging: boolean, level: number) => !charging && level <= 0.2;

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const base64ToBlob = (base64: string, mimeType: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const useConnectionStatus = (socketService: SocketService): ConnectionState => {
  const [status, setStatus] = useState(socketService.getStatus());
  const [quality, setQuality] = useState<ConnectionQuality>('offline');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [queueState, setQueueState] = useState<ConnectionState['queueState']>('idle');
  const [queuedCount, setQueuedCount] = useState(socketService.getQueuedCount());
  const [lowPowerMode, setLowPowerMode] = useState(false);

  const updateSnapshot = useCallback(() => {
    const currentStatus = socketService.getStatus();
    const queued = socketService.getQueuedCount();
    setStatus(currentStatus);
    setQueuedCount(queued);
    setQueueState(currentStatus !== 'connected' ? 'offline' : queued > 0 ? 'queued' : 'idle');
  }, [socketService]);

  useEffect(() => {
    const unsubscribeQuality = socketService.onConnectionQuality((payload) => {
      setQuality(payload.quality);
      setLatencyMs(payload.latencyMs);
    });
    const unsubscribeConnect = socketService.on('connect', updateSnapshot);
    const unsubscribeDisconnect = socketService.on('disconnect', updateSnapshot);
    updateSnapshot();
    return () => {
      unsubscribeQuality();
      unsubscribeConnect();
      unsubscribeDisconnect();
    };
  }, [socketService, updateSnapshot]);

  useEffect(() => {
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
      if (!batteryManager) {
        return;
      }
      const updateBattery = () => {
        setLowPowerMode(computeLowPower(batteryManager!.charging, batteryManager!.level));
      };
      updateBattery();
      batteryManager.addEventListener('chargingchange', updateBattery);
      batteryManager.addEventListener('levelchange', updateBattery);
      cleanup = () => {
        batteryManager?.removeEventListener('chargingchange', updateBattery);
        batteryManager?.removeEventListener('levelchange', updateBattery);
      };
    };

    void attachBattery();
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const intervalMs = lowPowerMode ? LOW_POWER_TICK_MS : MIN_TICK_MS;
    const timer = setInterval(updateSnapshot, intervalMs);
    return () => clearInterval(timer);
  }, [lowPowerMode, updateSnapshot]);

  return useMemo(
    () => ({
      status,
      quality,
      latencyMs,
      queueState,
      queuedCount,
    }),
    [latencyMs, quality, queuedCount, queueState, status],
  );
};

const useBatteryInfo = (): BatteryInfo => {
  const [battery, setBattery] = useState<BatteryInfo>({
    supported: false,
    level: null,
    charging: null,
  });

  useEffect(() => {
    let batteryManager: BatteryManagerLike | null = null;
    let cleanup: (() => void) | null = null;

    const attachBattery = async () => {
      if (typeof navigator === 'undefined' || !('getBattery' in navigator)) {
        setBattery((prev) => ({ ...prev, supported: false }));
        return;
      }
      try {
        batteryManager = await (navigator as Navigator & {
          getBattery: () => Promise<BatteryManagerLike>;
        }).getBattery();
      } catch {
        setBattery((prev) => ({ ...prev, supported: false }));
        return;
      }
      if (!batteryManager) {
        setBattery((prev) => ({ ...prev, supported: false }));
        return;
      }
      const updateBattery = () => {
        setBattery({
          supported: true,
          level: batteryManager!.level,
          charging: batteryManager!.charging,
        });
      };
      updateBattery();
      batteryManager.addEventListener('chargingchange', updateBattery);
      batteryManager.addEventListener('levelchange', updateBattery);
      cleanup = () => {
        batteryManager?.removeEventListener('chargingchange', updateBattery);
        batteryManager?.removeEventListener('levelchange', updateBattery);
      };
    };

    void attachBattery();
    return () => {
      cleanup?.();
    };
  }, []);

  return battery;
};

const useUserActivity = (
  socketService: SocketService,
  channelCode: string,
): UserPresence => {
  const [status, setStatus] = useState<UserPresence>('active');
  const [lowPowerMode, setLowPowerMode] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const lastEmitRef = useRef(0);

  const emitActivity = useCallback(() => {
    const now = Date.now();
    if (now - lastEmitRef.current < MIN_TICK_MS) {
      return;
    }
    socketService.emit('user:activity', { channelCode });
    lastEmitRef.current = now;
  }, [channelCode, socketService]);

  const handleActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setStatus('active');
    emitActivity();
  }, [emitActivity]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleActivity();
      }
    };
    window.addEventListener('pointerdown', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('focus', handleActivity);
    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pointerdown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('focus', handleActivity);
      window.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [handleActivity]);

  useEffect(() => {
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
      if (!batteryManager) {
        return;
      }
      const updateBattery = () => {
        setLowPowerMode(computeLowPower(batteryManager!.charging, batteryManager!.level));
      };
      updateBattery();
      batteryManager.addEventListener('chargingchange', updateBattery);
      batteryManager.addEventListener('levelchange', updateBattery);
      cleanup = () => {
        batteryManager?.removeEventListener('chargingchange', updateBattery);
        batteryManager?.removeEventListener('levelchange', updateBattery);
      };
    };

    void attachBattery();
    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const intervalMs = lowPowerMode ? LOW_POWER_TICK_MS : MIN_TICK_MS;
    const timer = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      const nextStatus: UserPresence =
        elapsed >= AWAY_AFTER_MS ? 'away' : elapsed >= IDLE_AFTER_MS ? 'idle' : 'active';
      setStatus(nextStatus);
      emitActivity();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [emitActivity, lowPowerMode]);

  return status;
};

export const ChannelScreen = ({ socketService, channelCode, nickname }: ChannelScreenProps) => {
  const [joinError, setJoinError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isSendingAudio, setIsSendingAudio] = useState(false);
  const [activeEmergency, setActiveEmergency] = useState<EmergencyBroadcast | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const recordStartRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connection = useConnectionStatus(socketService);
  const presence = useUserActivity(socketService, channelCode);
  const battery = useBatteryInfo();

  const { startRecording, stopRecording, isRecording, audioLevel, error: recorderError } =
    useAudioRecorder();
  const { enqueueAudio, playEmergencyTone, stopAll, isPlaying } = useAudioPlayer();

  const {
    sendEmergency,
    isSending: isEmergencySending,
    error: emergencyError,
    cooldownMs,
  } = useEmergencyBroadcast({
    socketService,
    playSosTone: playEmergencyTone,
    interruptAudio: stopAll,
    onBroadcastReceived: (broadcast) => {
      setActiveEmergency(broadcast);
    },
  });

  const joinChannel = useCallback(async () => {
    setJoinError(null);
    try {
      const response = await socketService.joinChannel({ channelCode, nickname });
      if (!response.ok) {
        setJoinError(response.error);
        return;
      }
      setUserId(response.data.user.id);
      setUsers((prev) => {
        const filtered = prev.filter((user) => user.id !== response.data.user.id);
        return [
          { id: response.data.user.id, nickname: response.data.user.nickname, isSelf: true },
          ...filtered.map((user) => ({ ...user, isSelf: user.id === response.data.user.id })),
        ];
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to join channel.';
      setJoinError(message);
    }
  }, [channelCode, nickname, socketService]);

  useEffect(() => {
    let mounted = true;
    socketService.connect();
    void joinChannel();

    const unsubscribeConnect = socketService.on('connect', () => {
      if (mounted) {
        void joinChannel();
      }
    });

    return () => {
      mounted = false;
      unsubscribeConnect();
      void socketService.leaveChannel({ channelCode });
      socketService.disconnect();
    };
  }, [channelCode, joinChannel, socketService]);

  useEffect(() => {
    const clearNoticeTimer = () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
    const unsubscribe = socketService.onAudioSendStatus((update) => {
      if (update.status === 'sent' && update.fromQueue) {
        setSendNotice('Queued messages sent.');
      }
      if (update.status === 'queued' && !update.fromQueue) {
        setSendNotice('Message queued while offline.');
      }
      if (update.status === 'failed') {
        setSendNotice(null);
      }
      if (update.status === 'sent' || update.status === 'queued') {
        clearNoticeTimer();
        noticeTimerRef.current = setTimeout(() => {
          setSendNotice(null);
        }, 3000);
      }
    });
    return () => {
      unsubscribe();
      clearNoticeTimer();
    };
  }, [socketService]);

  useEffect(() => {
    const unsubscribeJoined = socketService.on('user:joined', (payload: { user?: UserSummary }) => {
      if (!payload?.user) {
        return;
      }
      setUsers((prev) => {
        const exists = prev.some((user) => user.id === payload.user!.id);
        if (exists) {
          return prev;
        }
        return [...prev, { id: payload.user.id, nickname: payload.user.nickname }];
      });
    });

    const unsubscribeLeft = socketService.on('user:left', (payload: { user?: UserSummary }) => {
      if (!payload?.user) {
        return;
      }
      setUsers((prev) => prev.filter((user) => user.id !== payload.user!.id));
    });

    return () => {
      unsubscribeJoined();
      unsubscribeLeft();
    };
  }, [socketService]);

  const handleStartRecording = useCallback(async () => {
    recordStartRef.current = Date.now();
    await startRecording();
  }, [startRecording]);

  const handleStopRecording = useCallback(async () => {
    setSendError(null);
    const blob = await stopRecording();
    if (!blob) {
      return;
    }
    if (!userId) {
      setSendError('Not connected to a channel.');
      return;
    }

    const { maxBytes, maxDurationMs } = socketService.getAudioLimits();
    if (blob.size > maxBytes) {
      setSendError('Recording too large to send.');
      return;
    }

    const startedAt = recordStartRef.current ?? Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    recordStartRef.current = null;
    if (durationMs > maxDurationMs) {
      setSendError('Recording too long to send.');
      return;
    }

    setIsSendingAudio(true);
    try {
      const buffer = await blob.arrayBuffer();
      const payloadBase64 = arrayBufferToBase64(buffer);
      const mimeType = normalizeAudioMime(blob.type || 'audio/webm');
      const payload: SendAudioMessagePayload = {
        channelCode,
        senderId: userId,
        senderNickname: nickname,
        audioBase64: payloadBase64,
        mimeType,
        durationMs,
        priority: 'routine',
      };

      const result = await socketService.sendAudioMessage(payload);
      if (result.status === 'failed') {
        setSendError(result.error);
      }
      if (result.status === 'queued') {
        setSendError(result.error ?? 'Queued for retry.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send audio.';
      setSendError(message);
    } finally {
      setIsSendingAudio(false);
    }
  }, [channelCode, nickname, socketService, stopRecording, userId]);

  useEffect(() => {
    const unsubscribe = socketService.on<[AudioMessageEvent]>('audio-message', (payload) => {
      if (!payload?.audioBase64 || !payload.mimeType) {
        return;
      }
      const blob = base64ToBlob(payload.audioBase64, payload.mimeType);
      enqueueAudio(blob, payload.priority);
    });
    return () => {
      unsubscribe();
    };
  }, [enqueueAudio, socketService]);

  useEffect(() => {
    const unsubscribe = socketService.on<[AudioHistoryPayload]>('audio-history', (payload) => {
      if (!payload?.messages || payload.messages.length === 0) {
        return;
      }
      payload.messages.forEach((message) => {
        if (!message.audioBase64 || !message.mimeType) {
          return;
        }
        const blob = base64ToBlob(message.audioBase64, message.mimeType);
        enqueueAudio(blob, message.priority, message.id, {
          allowInterrupt: false,
          respectPriority: false,
        });
      });
    });
    return () => {
      unsubscribe();
    };
  }, [enqueueAudio, socketService]);

  const handleEmergencyConfirm = useCallback(() => {
    void sendEmergency('Emergency broadcast');
  }, [sendEmergency]);

  const handleEmergencyAcknowledge = useCallback(() => {
    setActiveEmergency(null);
  }, []);

  const canTalk = !joinError && !isEmergencySending;
  const isReceiving = isPlaying && !isRecording && !isSendingAudio;
  const canSendEmergency = connection.status === 'connected' && !isEmergencySending;

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6">
      {connection.status !== 'connected' ? (
        <div className="w-full rounded-xl border border-amber-500/60 bg-amber-500/20 px-4 py-2 text-sm text-amber-100">
          Offline. Messages will queue until reconnected.
        </div>
      ) : null}

      <StatusBar
        connectionStatus={connection.status}
        quality={connection.quality}
        latencyMs={connection.latencyMs}
        presence={presence}
        queuedCount={connection.queuedCount}
        battery={battery}
      />

      {joinError ? <p className="text-sm text-red-300">{joinError}</p> : null}
      {recorderError ? <p className="text-sm text-red-300">{recorderError}</p> : null}
      {sendError ? <p className="text-sm text-red-300">{sendError}</p> : null}
      {sendNotice ? <p className="text-sm text-emerald-300">{sendNotice}</p> : null}

      <UserList users={users} />

      <PushToTalkButton
        isRecording={isRecording}
        isSending={isSendingAudio}
        isReceiving={isReceiving}
        audioLevel={audioLevel}
        onStartRecording={handleStartRecording}
        onStopRecording={handleStopRecording}
        disabled={!canTalk}
      />

      <EmergencyBroadcastButton
        onConfirm={handleEmergencyConfirm}
        isSending={isEmergencySending}
        cooldownMs={cooldownMs}
        error={emergencyError}
        disabled={!canSendEmergency}
      />

      {activeEmergency ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-red-900/95 px-6 text-center text-white">
          <div className="text-2xl font-semibold uppercase tracking-wide">
            Emergency Broadcast
          </div>
          <div className="text-lg">
            {activeEmergency.fromNickname} • Channel {activeEmergency.channelCode}
          </div>
          <div className="max-w-md text-base text-white/90">{activeEmergency.message}</div>
          <button
            type="button"
            onClick={handleEmergencyAcknowledge}
            className="w-full max-w-xs rounded-2xl border-2 border-white/80 bg-white/10 px-6 py-4 text-base font-semibold uppercase tracking-wide text-white active:scale-[0.98]"
          >
            Acknowledge
          </button>
        </div>
      ) : null}
    </div>
  );
};
