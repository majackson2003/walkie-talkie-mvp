import { useCallback, useEffect, useRef, useState } from 'react';

type AudioRecorderState = {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  isRecording: boolean;
  audioLevel: number;
  error: string | null;
};

const MAX_RECORDING_MS = 30_000;
const USER_GESTURE_WINDOW_MS = 1_000;

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const;

export const useAudioRecorder = (): AudioRecorderState => {
  const [isRecording, setIsRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopResolverRef = useRef<((blob: Blob | null) => void) | null>(null);
  const stopPromiseRef = useRef<Promise<Blob | null> | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);
  const lastGestureRef = useRef(0);

  const AudioContextClass =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : null;

  const pickMimeType = () => {
    if (typeof MediaRecorder === 'undefined') {
      return null;
    }
    for (const type of PREFERRED_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return null;
  };

  const stopLevelMeter = () => {
    if (levelRafRef.current !== null) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
    setAudioLevel(0);
  };

  const startLevelMeter = (analyser: AnalyserNode) => {
    const bufferLength = analyser.fftSize;
    const data = new Uint8Array(bufferLength);

    const update = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < bufferLength; i += 1) {
        const normalized = (data[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / bufferLength);
      const level = Math.min(100, Math.round(rms * 100));
      setAudioLevel(level);
      levelRafRef.current = requestAnimationFrame(update);
    };

    update();
  };

  const cleanupMedia = () => {
    stopLevelMeter();
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;
      mediaRecorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    chunksRef.current = [];
  };

  const finalizeRecording = (blob: Blob | null) => {
    isRecordingRef.current = false;
    setIsRecording(false);
    cleanupMedia();
    if (stopResolverRef.current) {
      stopResolverRef.current(blob);
      stopResolverRef.current = null;
      stopPromiseRef.current = null;
    }
  };

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !isRecordingRef.current) {
      return null;
    }
    if (stopPromiseRef.current) {
      return stopPromiseRef.current;
    }

    stopPromiseRef.current = new Promise<Blob | null>((resolve) => {
      stopResolverRef.current = resolve;
      try {
        recorder.stop();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop recording.');
        resolve(null);
      }
    });

    return stopPromiseRef.current;
  }, []);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) {
      return;
    }
    setError(null);

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      setError('Recording is unavailable while the app is in the background.');
      return;
    }

    if (Date.now() - lastGestureRef.current > USER_GESTURE_WINDOW_MS) {
      setError('Tap and hold to start recording.');
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access is not supported on this device.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setError('MediaRecorder is not supported in this browser.');
      return;
    }

    if (!AudioContextClass) {
      setError('AudioContext is not supported in this browser.');
      return;
    }

    try {
      cleanupMedia();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const audioContext = new AudioContextClass();
      try {
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
      } catch {
        setError('Audio cannot start until you tap the screen.');
        cleanupMedia();
        return;
      }
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError('Recording failed.');
        finalizeRecording(null);
      };

      recorder.onstop = () => {
        const blob =
          chunksRef.current.length > 0
            ? new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
            : null;
        finalizeRecording(blob);
      };

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      recorder.start();
      isRecordingRef.current = true;
      setIsRecording(true);
      startLevelMeter(analyser);

      maxTimerRef.current = setTimeout(() => {
        void stopRecording();
      }, MAX_RECORDING_MS);
    } catch (err) {
      const message = (() => {
        if (err instanceof DOMException) {
          if (err.name === 'NotAllowedError') return 'Microphone permission denied.';
          if (err.name === 'NotFoundError') return 'No microphone available.';
          if (err.name === 'NotReadableError') return 'Microphone is in use by another app.';
          if (err.name === 'OverconstrainedError') return 'Microphone constraints could not be satisfied.';
        }
        return err instanceof Error ? err.message : 'Unable to access microphone.';
      })();
      setError(message);
      cleanupMedia();
    }
  }, [AudioContextClass, stopRecording]);

  useEffect(() => {
    const markGesture = () => {
      lastGestureRef.current = Date.now();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', markGesture, { passive: true, capture: true });
      window.addEventListener('touchstart', markGesture, { passive: true, capture: true });
      window.addEventListener('keydown', markGesture, { passive: true, capture: true });
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', markGesture, true);
        window.removeEventListener('touchstart', markGesture, true);
        window.removeEventListener('keydown', markGesture, true);
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && isRecordingRef.current) {
        setError('Recording stopped when the app went to background.');
        void stopRecording();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [stopRecording]);

  useEffect(() => {
    return () => {
      void stopRecording();
      cleanupMedia();
    };
  }, [stopRecording]);

  return {
    startRecording,
    stopRecording,
    isRecording,
    audioLevel,
    error,
  };
};
