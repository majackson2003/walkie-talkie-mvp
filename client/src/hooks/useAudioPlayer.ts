import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MessagePriority } from '@walkie/shared/types';

export type AudioPriority = MessagePriority;

type QueueItem = {
  id: string;
  priority: AudioPriority;
  kind: 'blob' | 'sos';
  blob?: Blob;
};

type EnqueueOptions = {
  allowInterrupt?: boolean;
  respectPriority?: boolean;
};

type UseAudioPlayer = {
  enqueueAudio: (blob: Blob, priority?: AudioPriority, id?: string, options?: EnqueueOptions) => void;
  playEmergencyTone: () => void;
  stopAll: () => void;
  isPlaying: boolean;
  volume: number;
  setVolume: (value: number) => void;
};

const DEFAULT_VOLUME = 0.9;
const VOLUME_STORAGE_KEY = 'walkie:volume';
const FADE_IN_MS = 60;
const FADE_OUT_MS = 80;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const loadVolume = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_VOLUME;
  }
  const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);
  const parsed = stored ? Number(stored) : NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_VOLUME;
  }
  return clamp(parsed, 0, 1);
};

const saveVolume = (value: number) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(VOLUME_STORAGE_KEY, String(value));
};

const decodeAudio = async (context: AudioContext, data: ArrayBuffer) => {
  const copy = data.slice(0);
  const result = context.decodeAudioData(copy);
  if (result instanceof Promise) {
    return result;
  }
  return new Promise<AudioBuffer>((resolve, reject) => {
    context.decodeAudioData(copy, resolve, reject);
  });
};

const renderSOSTone = async (sampleRate: number) => {
  const dot = 0.12;
  const dash = dot * 3;
  const gap = dot;
  const letterGap = dot * 3;
  const frequency = 880;

  const sequence = [
    dot,
    gap,
    dot,
    gap,
    dot,
    letterGap,
    dash,
    gap,
    dash,
    gap,
    dash,
    letterGap,
    dot,
    gap,
    dot,
    gap,
    dot,
  ];

  const totalDuration = sequence.reduce((sum, value) => sum + value, 0) + 0.2;
  const length = Math.ceil(totalDuration * sampleRate);
  const offlineContext = new OfflineAudioContext(1, length, sampleRate);
  const oscillator = offlineContext.createOscillator();
  const gain = offlineContext.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.value = 0;

  oscillator.connect(gain);
  gain.connect(offlineContext.destination);

  let cursor = 0;
  const ramp = 0.01;
  for (let index = 0; index < sequence.length; index += 1) {
    const duration = sequence[index];
    const isTone = index % 2 === 0;
    if (isTone) {
      gain.gain.setValueAtTime(0, cursor);
      gain.gain.linearRampToValueAtTime(1, cursor + ramp);
      gain.gain.setValueAtTime(1, Math.max(cursor + duration - ramp, cursor + ramp));
      gain.gain.linearRampToValueAtTime(0, cursor + duration);
    }
    cursor += duration;
  }

  oscillator.start(0);
  oscillator.stop(totalDuration);

  return offlineContext.startRendering();
};

export const useAudioPlayer = (): UseAudioPlayer => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolumeState] = useState(loadVolume);

  const queueRef = useRef<QueueItem[]>([]);
  const currentRef = useRef<{
    token: number;
    priority: AudioPriority;
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const playbackTokenRef = useRef(0);
  const isUnmountedRef = useRef(false);

  const ensureContext = useCallback(() => {
    if (contextRef.current) {
      return contextRef.current;
    }
    const AudioContextClass =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : null;
    if (!AudioContextClass) {
      throw new Error('AudioContext not available.');
    }
    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);
    contextRef.current = context;
    masterGainRef.current = master;
    return context;
  }, [volume]);

  const updateMasterVolume = useCallback(
    (value: number) => {
      const clamped = clamp(value, 0, 1);
      const master = masterGainRef.current;
      if (master) {
        master.gain.setValueAtTime(clamped, master.context.currentTime);
      }
      saveVolume(clamped);
      setVolumeState(clamped);
    },
    [setVolumeState],
  );

  const stopCurrent = useCallback(async () => {
    const current = currentRef.current;
    if (!current) {
      return;
    }
    playbackTokenRef.current += 1;
    const context = contextRef.current;
    if (context) {
      const now = context.currentTime;
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueAtTime(current.gain.gain.value, now);
      current.gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_MS / 1000);
      try {
        current.source.stop(now + FADE_OUT_MS / 1000 + 0.02);
      } catch {
        // ignore
      }
    } else {
      try {
        current.source.stop();
      } catch {
        // ignore
      }
    }
    currentRef.current = null;
    setIsPlaying(false);
  }, []);

  const playNext = useCallback(async () => {
    if (currentRef.current || queueRef.current.length === 0 || isUnmountedRef.current) {
      return;
    }

    const next = queueRef.current.shift();
    if (!next) {
      return;
    }

    const token = playbackTokenRef.current + 1;
    playbackTokenRef.current = token;
    let context: AudioContext;
    try {
      context = ensureContext();
      if (context.state === 'suspended') {
        await context.resume();
      }
    } catch {
      return;
    }

    let buffer: AudioBuffer;
    try {
      if (next.kind === 'sos') {
        buffer = await renderSOSTone(context.sampleRate);
      } else if (next.blob) {
        const arrayBuffer = await next.blob.arrayBuffer();
        buffer = await decodeAudio(context, arrayBuffer);
      } else {
        return;
      }
    } catch {
      playNext();
      return;
    }

    if (token !== playbackTokenRef.current) {
      return;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = 0;
    const master = masterGainRef.current;
    if (!master) {
      return;
    }
    source.connect(gain);
    gain.connect(master);

    currentRef.current = {
      token,
      priority: next.priority,
      source,
      gain,
    };
    setIsPlaying(true);

    const startAt = context.currentTime + 0.01;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + FADE_IN_MS / 1000);
    source.start(startAt);

    source.onended = () => {
      if (currentRef.current?.token !== token) {
        return;
      }
      currentRef.current = null;
      setIsPlaying(false);
      playNext();
    };
  }, [ensureContext]);

  const enqueueItem = useCallback(
    (item: QueueItem, options?: EnqueueOptions) => {
      const allowInterrupt = options?.allowInterrupt ?? true;
      const respectPriority = options?.respectPriority ?? true;
      const current = currentRef.current;
      if (current) {
        const shouldInterrupt = allowInterrupt && item.priority === 'urgent';
        if (shouldInterrupt) {
          void stopCurrent().then(() => {
            queueRef.current.unshift(item);
            playNext();
          });
          return;
        }
      }
      if (!respectPriority) {
        queueRef.current.push(item);
        void playNext();
        return;
      }
      if (item.priority === 'urgent') {
        queueRef.current.unshift(item);
      } else if (item.priority === 'important') {
        const index = queueRef.current.findIndex((queued) => queued.priority === 'routine');
        if (index === -1) {
          queueRef.current.push(item);
        } else {
          queueRef.current.splice(index, 0, item);
        }
      } else {
        queueRef.current.push(item);
      }
      void playNext();
    },
    [playNext, stopCurrent],
  );

  const enqueueAudio = useCallback(
    (
      blob: Blob,
      priority: AudioPriority = 'routine',
      id = crypto.randomUUID(),
      options?: EnqueueOptions,
    ) => {
      enqueueItem({ id, priority, kind: 'blob', blob }, options);
    },
    [enqueueItem],
  );

  const playEmergencyTone = useCallback(() => {
    enqueueItem({ id: crypto.randomUUID(), priority: 'urgent', kind: 'sos' });
  }, [enqueueItem]);

  const stopAll = useCallback(() => {
    queueRef.current = [];
    void stopCurrent();
  }, [stopCurrent]);

  useEffect(() => {
    const resumeFromGesture = () => {
      const context = contextRef.current;
      if (!context) {
        return;
      }
      if (context.state === 'suspended') {
        context.resume().then(() => {
          if (!currentRef.current && queueRef.current.length > 0) {
            void playNext();
          }
        }).catch(() => undefined);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', resumeFromGesture, { passive: true });
      window.addEventListener('touchstart', resumeFromGesture, { passive: true });
      window.addEventListener('keydown', resumeFromGesture, { passive: true });
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', resumeFromGesture);
        window.removeEventListener('touchstart', resumeFromGesture);
        window.removeEventListener('keydown', resumeFromGesture);
      }
    };
  }, [playNext]);

  useEffect(() => {
    const handleVisibility = () => {
      const context = contextRef.current;
      if (!context) {
        return;
      }
      if (document.visibilityState === 'hidden') {
        if (context.state === 'running') {
          context.suspend().catch(() => undefined);
        }
        return;
      }
      if (context.state === 'suspended') {
        context.resume().then(() => {
          if (!currentRef.current && queueRef.current.length > 0) {
            void playNext();
          }
        }).catch(() => undefined);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
      window.addEventListener('pageshow', handleVisibility);
      window.addEventListener('pagehide', handleVisibility);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener('pageshow', handleVisibility);
        window.removeEventListener('pagehide', handleVisibility);
      }
    };
  }, [playNext]);

  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      queueRef.current = [];
      void stopCurrent();
      if (contextRef.current) {
        contextRef.current.close().catch(() => undefined);
        contextRef.current = null;
      }
      masterGainRef.current = null;
    };
  }, [stopCurrent]);

  return useMemo(
    () => ({
      enqueueAudio,
      playEmergencyTone,
      stopAll,
      isPlaying,
      volume,
      setVolume: updateMasterVolume,
    }),
    [enqueueAudio, playEmergencyTone, stopAll, isPlaying, updateMasterVolume, volume],
  );
};
