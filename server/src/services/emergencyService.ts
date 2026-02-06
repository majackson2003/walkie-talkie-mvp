import { randomUUID } from 'crypto';
import type { Server, Socket } from 'socket.io';
import type { EmergencyBroadcast, MessagePriority, User } from '@walkie/shared/types';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 200;
const MIN_MESSAGE_LENGTH = 1;

type EmergencyPayload = {
  message: string;
};

type AckResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      code: 'invalid_payload' | 'rate_limited' | 'not_found' | 'internal';
      retryAfterMs: number;
    };

type EmergencyContext = {
  user: User;
  channelCode: string;
};

type EmergencyDeps = {
  getUserContext: (socketId: string) => EmergencyContext | null;
  touchActivity: (socketId: string) => void;
};

export const createEmergencyService = (io: Server, deps: EmergencyDeps) => {
  const lastBroadcastByUserId = new Map<string, number>();

  const normalizeMessage = (value: unknown) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_MESSAGE_LENGTH || trimmed.length > MAX_MESSAGE_LENGTH) {
      return null;
    }
    return trimmed;
  };

  const respond = <T>(socket: Socket, ack: ((response: AckResponse<T>) => void) | undefined, payload: AckResponse<T>) => {
    if (ack) {
      ack(payload);
      return;
    }
    if (!payload.ok) {
      socket.emit('emergency:error', { error: payload.error, code: payload.code, retryAfterMs: payload.retryAfterMs });
    }
  };

  const buildBroadcast = (context: EmergencyContext, message: string): EmergencyBroadcast => ({
    id: randomUUID(),
    channelCode: context.channelCode,
    fromUserId: context.user.id,
    fromNickname: context.user.nickname,
    createdAt: new Date(),
    priority: 'urgent' as MessagePriority,
    message,
  });

  const handleBroadcast = (
    socket: Socket,
    payload: unknown,
    ack?: (response: AckResponse<{ broadcast: EmergencyBroadcast }>) => void,
  ) => {
    const message = normalizeMessage((payload as EmergencyPayload)?.message);
    if (!message) {
      respond(socket, ack, {
        ok: false,
        error: 'Invalid emergency message.',
        code: 'invalid_payload',
        retryAfterMs: 0,
      });
      return;
    }

    const context = deps.getUserContext(socket.id);
    if (!context) {
      respond(socket, ack, {
        ok: false,
        error: 'User is not in a channel.',
        code: 'not_found',
        retryAfterMs: 0,
      });
      return;
    }

    const now = Date.now();
    const lastSentAt = lastBroadcastByUserId.get(context.user.id);
    if (lastSentAt && now - lastSentAt < RATE_LIMIT_WINDOW_MS) {
      const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - lastSentAt);
      respond(socket, ack, {
        ok: false,
        error: `Rate limited. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
        code: 'rate_limited',
        retryAfterMs,
      });
      return;
    }

    lastBroadcastByUserId.set(context.user.id, now);
    deps.touchActivity(socket.id);

    const broadcast = buildBroadcast(context, message);
    console.warn('[emergency] broadcast', {
      id: broadcast.id,
      fromUserId: broadcast.fromUserId,
      fromNickname: broadcast.fromNickname,
      channelCode: broadcast.channelCode,
      createdAt: broadcast.createdAt.toISOString(),
    });

    io.emit('emergency:alert', { broadcast });
    respond(socket, ack, { ok: true, data: { broadcast } });
  };

  return {
    handleBroadcast,
  };
};
