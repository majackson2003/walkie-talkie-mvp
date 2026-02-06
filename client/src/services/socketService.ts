import { io, type Socket } from 'socket.io-client';
import type { ConnectionStatus, MessagePriority } from '@walkie/shared/types';

type ConnectionQuality = 'good' | 'ok' | 'poor' | 'offline';

type ConnectionQualityUpdate = {
  quality: ConnectionQuality;
  latencyMs: number | null;
  at: Date;
};

type ChannelCreatePayload = {
  nickname: string;
};

type ChannelJoinPayload = {
  channelCode: string;
  nickname: string;
};

type ChannelLeavePayload = {
  channelCode: string;
};

export type AudioLocation = {
  lat: number;
  lng: number;
  accuracy?: number;
};

export type SendAudioMessagePayload = {
  channelCode: string;
  senderId: string;
  senderNickname: string;
  audioBase64: string;
  mimeType: string;
  durationMs: number;
  priority: MessagePriority;
  location?: AudioLocation;
};

export type AudioMessageEvent = {
  id: string;
  channelCode: string;
  senderNickname: string;
  audioBase64: string;
  mimeType: string;
  priority: MessagePriority;
  timestamp: string;
  location?: AudioLocation;
};

export type SendAudioResult =
  | { status: 'sent' }
  | { status: 'queued'; error?: string }
  | { status: 'failed'; error: string };

export type AudioSendUpdate = {
  status: 'sent' | 'queued' | 'failed';
  fromQueue: boolean;
  error?: string;
  queuedCount: number;
};

type AckResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code: 'invalid_payload' | 'channel_full' | 'not_found' | 'internal' | 'rate_limited';
      retryAfterMs?: number;
    };

type PendingEmit = {
  event: string;
  payload: unknown;
  expectAck: boolean;
  timeoutMs: number;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
};

const CHANNEL_CODE_REGEX = /^\d{4}$/;
const MIN_NICKNAME_LENGTH = 1;
const MAX_NICKNAME_LENGTH = 24;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const MAX_QUEUE_SIZE = 10;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_AUDIO_BYTES = 1_000_000;
const MAX_AUDIO_DURATION_MS = 30_000;
const MAX_AUDIO_RETRY_QUEUE = 10;
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]);

export class SocketService {
  private socket: Socket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;
  private readonly queue: PendingEmit[] = [];
  private readonly audioRetryQueue: SendAudioMessagePayload[] = [];
  private readonly qualityListeners = new Set<(update: ConnectionQualityUpdate) => void>();
  private readonly audioStatusListeners = new Set<(update: AudioSendUpdate) => void>();

  constructor(private readonly serverUrl: string) {}

  getStatus() {
    return this.status;
  }

  getQueuedCount() {
    return this.queue.length + this.audioRetryQueue.length;
  }

  getAudioLimits() {
    return {
      maxBytes: MAX_AUDIO_BYTES,
      maxDurationMs: MAX_AUDIO_DURATION_MS,
    };
  }

  onConnectionQuality(listener: (update: ConnectionQualityUpdate) => void) {
    this.qualityListeners.add(listener);
    return () => {
      this.qualityListeners.delete(listener);
    };
  }

  onAudioSendStatus(listener: (update: AudioSendUpdate) => void) {
    this.audioStatusListeners.add(listener);
    return () => {
      this.audioStatusListeners.delete(listener);
    };
  }

  connect() {
    if (this.socket?.connected) {
      return;
    }

    const socket = this.ensureSocket();

    this.shouldReconnect = true;
    this.updateStatus('connecting');
    socket.connect();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.updateStatus('disconnected');
    this.emitQuality({ quality: 'offline', latencyMs: null, at: new Date() });
    this.socket?.disconnect();
  }

  async createChannel(payload: ChannelCreatePayload) {
    const nickname = this.normalizeNickname(payload.nickname);
    if (!nickname) {
      throw new Error('Invalid nickname.');
    }
    return this.emitWithAck('channel:create', { nickname });
  }

  async joinChannel(payload: ChannelJoinPayload) {
    const nickname = this.normalizeNickname(payload.nickname);
    if (!nickname || !this.isValidChannelCode(payload.channelCode)) {
      throw new Error('Invalid channel code or nickname.');
    }
    return this.emitWithAck('channel:join', { channelCode: payload.channelCode, nickname });
  }

  async leaveChannel(payload: ChannelLeavePayload) {
    if (!this.isValidChannelCode(payload.channelCode)) {
      throw new Error('Invalid channel code.');
    }
    return this.emitWithAck('channel:leave', { channelCode: payload.channelCode });
  }

  async sendAudioMessage(payload: SendAudioMessagePayload): Promise<SendAudioResult> {
    const validationError = this.validateAudioPayload(payload);
    if (validationError) {
      this.emitAudioStatus({ status: 'failed', fromQueue: false, error: validationError });
      return { status: 'failed', error: validationError };
    }

    if (!this.socket || !this.socket.connected) {
      this.queueAudioMessage(payload);
      this.emitAudioStatus({
        status: 'queued',
        fromQueue: false,
        error: 'Offline. Message queued for retry.',
      });
      return { status: 'queued', error: 'Offline. Message queued for retry.' };
    }

    try {
      const response = await this.emitWithAckNow<{ id: string; timestamp: string }>(
        'send-audio-message',
        payload,
        3_000,
      );
      if (response.ok) {
        this.emitAudioStatus({ status: 'sent', fromQueue: false });
        return { status: 'sent' };
      }
      if (response.code === 'internal') {
        this.queueAudioMessage(payload);
        this.emitAudioStatus({ status: 'queued', fromQueue: false, error: response.error });
        return { status: 'queued', error: response.error };
      }
      this.emitAudioStatus({ status: 'failed', fromQueue: false, error: response.error });
      return { status: 'failed', error: response.error };
    } catch (err) {
      this.queueAudioMessage(payload);
      const message = err instanceof Error ? err.message : 'Send failed. Queued for retry.';
      this.emitAudioStatus({ status: 'queued', fromQueue: false, error: message });
      return {
        status: 'queued',
        error: message,
      };
    }
  }

  request<T>(event: string, payload: unknown, timeoutMs?: number) {
    return this.emitWithAck<T>(event, payload, timeoutMs);
  }

  on<T extends unknown[]>(event: string, handler: (...args: T) => void) {
    const socket = this.ensureSocket();
    socket.on(event, handler);
    return () => {
      socket.off(event, handler);
    };
  }

  emit(event: string, payload: unknown) {
    const socket = this.ensureSocket();
    if (!socket.connected) {
      this.enqueue({
        event,
        payload,
        expectAck: false,
        timeoutMs: 0,
      });
      return;
    }
    socket.emit(event, payload);
  }

  private emitWithAck<T>(event: string, payload: unknown, timeoutMs = 3_000): Promise<AckResponse<T>> {
    const socket = this.ensureSocket();
    if (!socket.connected) {
      return new Promise((resolve, reject) => {
        this.enqueue({
          event,
          payload,
          expectAck: true,
          timeoutMs,
          resolve: (value) => resolve(value as AckResponse<T>),
          reject,
        });
      });
    }

    return this.emitWithAckNow<T>(event, payload, timeoutMs);
  }

  private emitWithAckNow<T>(event: string, payload: unknown, timeoutMs: number) {
    return new Promise<AckResponse<T>>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket unavailable.'));
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('Ack timeout.'));
      }, timeoutMs);

      this.socket.emit(event, payload, (response: AckResponse<T>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  private ensureSocket() {
    if (!this.socket) {
      this.socket = io(this.serverUrl, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
      });
      this.attachSocketHandlers(this.socket);
    }
    return this.socket;
  }

  private enqueue(item: PendingEmit) {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
    }
    this.queue.push(item);
  }

  private flushQueue() {
    if (!this.socket || !this.socket.connected) {
      return;
    }

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        continue;
      }

      if (!item.expectAck) {
        this.socket.emit(item.event, item.payload);
        continue;
      }

      this.emitWithAckNow(item.event, item.payload, item.timeoutMs)
        .then((response) => item.resolve?.(response))
        .catch((error: Error) => item.reject?.(error));
    }
  }

  private queueAudioMessage(payload: SendAudioMessagePayload) {
    if (this.audioRetryQueue.length >= MAX_AUDIO_RETRY_QUEUE) {
      this.audioRetryQueue.shift();
    }
    this.audioRetryQueue.push(payload);
  }

  private async flushAudioRetryQueue() {
    if (!this.socket || !this.socket.connected || this.audioRetryQueue.length === 0) {
      return;
    }
    const pending = [...this.audioRetryQueue];
    this.audioRetryQueue.length = 0;
    for (const payload of pending) {
      if (!this.socket?.connected) {
        this.queueAudioMessage(payload);
        break;
      }
      try {
        const response = await this.emitWithAckNow<{ id: string; timestamp: string }>(
          'send-audio-message',
          payload,
          3_000,
        );
        if (response.ok) {
          this.emitAudioStatus({ status: 'sent', fromQueue: true });
          continue;
        }
        if (response.code === 'internal') {
          this.queueAudioMessage(payload);
          this.emitAudioStatus({ status: 'queued', fromQueue: true, error: response.error });
          continue;
        }
        this.emitAudioStatus({ status: 'failed', fromQueue: true, error: response.error });
      } catch {
        this.queueAudioMessage(payload);
        this.emitAudioStatus({
          status: 'queued',
          fromQueue: true,
          error: 'Send failed. Queued for retry.',
        });
        break;
      }
    }
  }

  private attachSocketHandlers(socket: Socket) {
    socket.on('connect', () => {
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      this.updateStatus('connected');
      this.flushQueue();
      void this.flushAudioRetryQueue();
      this.startHeartbeat();
    });

    socket.on('disconnect', () => {
      this.updateStatus('disconnected');
      this.stopHeartbeat();
      this.emitQuality({ quality: 'offline', latencyMs: null, at: new Date() });
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    socket.on('connect_error', () => {
      this.updateStatus('disconnected');
      this.stopHeartbeat();
      this.emitQuality({ quality: 'offline', latencyMs: null, at: new Date() });
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || !this.socket.connected) {
        return;
      }

      const sentAt = performance.now();
      this.emitWithAck('client:heartbeat', { sentAt: Date.now() }, HEARTBEAT_TIMEOUT_MS)
        .then(() => {
          const latencyMs = Math.max(0, Math.round(performance.now() - sentAt));
          this.emitQuality({ quality: this.computeQuality(latencyMs), latencyMs, at: new Date() });
        })
        .catch(() => {
          this.emitQuality({ quality: 'poor', latencyMs: null, at: new Date() });
        });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    const attempt = this.reconnectAttempts;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    const jitter = 0.8 + Math.random() * 0.4;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      if (this.shouldReconnect) {
        this.updateStatus('connecting');
        this.socket?.connect();
      }
    }, Math.round(delay * jitter));
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private updateStatus(status: ConnectionStatus) {
    this.status = status;
  }

  private emitQuality(update: ConnectionQualityUpdate) {
    this.qualityListeners.forEach((listener) => listener(update));
  }

  private emitAudioStatus(update: Omit<AudioSendUpdate, 'queuedCount'>) {
    const payload: AudioSendUpdate = {
      ...update,
      queuedCount: this.audioRetryQueue.length,
    };
    this.audioStatusListeners.forEach((listener) => listener(payload));
  }

  private computeQuality(latencyMs: number): ConnectionQuality {
    if (latencyMs <= 200) {
      return 'good';
    }
    if (latencyMs <= 500) {
      return 'ok';
    }
    return 'poor';
  }

  private isValidChannelCode(value: unknown): value is string {
    return typeof value === 'string' && CHANNEL_CODE_REGEX.test(value);
  }

  private normalizeNickname(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_NICKNAME_LENGTH || trimmed.length > MAX_NICKNAME_LENGTH) {
      return null;
    }
    return trimmed;
  }

  private validateAudioPayload(payload: SendAudioMessagePayload) {
    if (!this.isValidChannelCode(payload.channelCode)) {
      return 'Invalid channel code.';
    }
    if (typeof payload.senderId !== 'string' || payload.senderId.trim().length === 0) {
      return 'Invalid sender id.';
    }
    if (!this.normalizeNickname(payload.senderNickname)) {
      return 'Invalid sender nickname.';
    }
    if (typeof payload.audioBase64 !== 'string' || payload.audioBase64.trim().length === 0) {
      return 'Invalid audio payload.';
    }
    if (!ALLOWED_MIME_TYPES.has(payload.mimeType)) {
      return 'Unsupported mime type.';
    }
    if (!Number.isFinite(payload.durationMs) || payload.durationMs <= 0) {
      return 'Invalid audio duration.';
    }
    if (payload.durationMs > MAX_AUDIO_DURATION_MS) {
      return 'Audio duration exceeds limit.';
    }
    if (!this.isValidPriority(payload.priority)) {
      return 'Invalid priority.';
    }
    const estimatedBytes = this.estimateBase64Bytes(payload.audioBase64);
    if (estimatedBytes === null) {
      return 'Invalid audio payload.';
    }
    if (estimatedBytes > MAX_AUDIO_BYTES) {
      return 'Audio payload too large.';
    }
    if (payload.location) {
      const { lat, lng, accuracy } = payload.location;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return 'Invalid location.';
      }
      if (accuracy !== undefined && !Number.isFinite(accuracy)) {
        return 'Invalid location.';
      }
    }
    return null;
  }

  private estimateBase64Bytes(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length % 4 !== 0) {
      return null;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      return null;
    }
    const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
  }

  private isValidPriority(value: unknown): value is MessagePriority {
    return value === 'routine' || value === 'important' || value === 'urgent';
  }
}
