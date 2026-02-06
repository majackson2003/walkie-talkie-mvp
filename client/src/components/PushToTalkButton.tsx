import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type PushToTalkButtonProps = {
  isRecording: boolean;
  isSending: boolean;
  isReceiving: boolean;
  audioLevel: number;
  onStartRecording: () => void;
  onStopRecording: () => void;
  maxDurationMs?: number;
  disabled?: boolean;
};

const LEVEL_SEGMENTS = 10;
const DEFAULT_MAX_DURATION_MS = 30_000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const vibrate = (pattern: number | number[]) => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
};

export const PushToTalkButton = ({
  isRecording,
  isSending,
  isReceiving,
  audioLevel,
  onStartRecording,
  onStopRecording,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  disabled = false,
}: PushToTalkButtonProps) => {
  const [pressedAt, setPressedAt] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(Math.ceil(maxDurationMs / 1000));
  const pressedRef = useRef(false);

  const isBusy = isSending || isReceiving;
  const isInteractive = !disabled && !isBusy;

  const status = useMemo(() => {
    if (isRecording) return 'recording';
    if (isSending) return 'sending';
    if (isReceiving) return 'receiving';
    return 'idle';
  }, [isRecording, isSending, isReceiving]);

  useEffect(() => {
    if (!isRecording) {
      setPressedAt(null);
      setRemainingSeconds(Math.ceil(maxDurationMs / 1000));
      return;
    }
    if (pressedAt === null) {
      setPressedAt(Date.now());
    }
  }, [isRecording, maxDurationMs, pressedAt]);

  useEffect(() => {
    if (!isRecording || pressedAt === null) {
      return;
    }
    const timer = setInterval(() => {
      const elapsed = Date.now() - pressedAt;
      const remainingMs = Math.max(0, maxDurationMs - elapsed);
      setRemainingSeconds(Math.ceil(remainingMs / 1000));
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [isRecording, maxDurationMs, pressedAt]);

  const handleStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!isInteractive || pressedRef.current) {
        return;
      }
      event.preventDefault();
      pressedRef.current = true;
      vibrate(10);
      onStartRecording();
    },
    [isInteractive, onStartRecording],
  );

  const handleStop = useCallback(() => {
    if (!pressedRef.current) {
      return;
    }
    pressedRef.current = false;
    vibrate([8, 16, 8]);
    onStopRecording();
  }, [onStopRecording]);

  const level = clamp(audioLevel, 0, 100);
  const activeSegments = Math.round((level / 100) * LEVEL_SEGMENTS);

  const buttonBase =
    'w-full max-w-xs select-none rounded-2xl px-6 py-5 text-center text-lg font-semibold shadow-lg transition active:scale-[0.98]';

  const statusStyles = {
    idle: 'bg-emerald-600 text-white shadow-emerald-900/40',
    recording: 'bg-red-600 text-white shadow-red-900/40',
    sending: 'bg-sky-600 text-white shadow-sky-900/40',
    receiving: 'bg-amber-500 text-slate-950 shadow-amber-900/40',
  };

  const statusLabel = {
    idle: 'Hold to Talk',
    recording: 'Recording...',
    sending: 'Sending...',
    receiving: 'Receiving...',
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <button
        type="button"
        aria-pressed={isRecording}
        aria-busy={isBusy}
        disabled={!isInteractive}
        onPointerDown={handleStart}
        onPointerUp={handleStop}
        onPointerLeave={handleStop}
        onPointerCancel={handleStop}
        className={`${buttonBase} ${statusStyles[status]} ${!isInteractive ? 'opacity-60' : ''}`}
      >
        <div className="flex flex-col items-center gap-2">
          <span>{statusLabel[status]}</span>
          <span className="text-sm font-medium tracking-wide text-white/80">
            {isRecording ? `Max ${remainingSeconds}s` : 'Press and hold'}
          </span>
        </div>
      </button>

      <div className="flex w-full max-w-xs items-center justify-between gap-1">
        {Array.from({ length: LEVEL_SEGMENTS }).map((_, index) => {
          const isActive = index < activeSegments;
          return (
            <div
              key={`level-${index}`}
              className={`h-3 flex-1 rounded-full ${
                isActive ? 'bg-emerald-400' : 'bg-slate-700'
              }`}
            />
          );
        })}
      </div>
    </div>
  );
};
