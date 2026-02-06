import { randomInt, randomUUID } from 'crypto';
import path from 'path';
import type { Server, Socket } from 'socket.io';
import type { AudioMessage, Channel, EmergencyBroadcast, MessagePriority, User } from '@walkie/shared/types';
import { DatabaseService } from './databaseService';
import { createEmergencyService } from './emergencyService';

const CHANNEL_CODE_REGEX = /^\d{4}$/;
const MAX_USERS_PER_CHANNEL = 20;
const MAX_CODE_GENERATION_ATTEMPTS = 200;
const MIN_NICKNAME_LENGTH = 1;
const MAX_NICKNAME_LENGTH = 24;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES ?? 1_000_000);
const MAX_AUDIO_DURATION_MS = Number(process.env.MAX_AUDIO_DURATION_MS ?? 30_000);
const AUDIO_RATE_LIMIT_WINDOW_MS = Number(process.env.AUDIO_RATE_LIMIT_WINDOW_MS ?? 60_000);
const AUDIO_RATE_LIMIT_MAX = Number(process.env.AUDIO_RATE_LIMIT_MAX ?? 30);
const DB_PATH =
  process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'walkie.sqlite');
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]);

export type ChannelState = {
  channel: Channel;
  users: Map<string, UserState>;
  lastActivityAt: Date;
};

export type UserState = {
  user: User;
  socketId: string;
  lastActivityAt: Date;
};

type AckResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: 'invalid_payload' | 'channel_full' | 'not_found' | 'internal' };

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

type ChannelCreateResponse = {
  channel: Channel;
  user: User;
};

type ChannelJoinResponse = {
  channel: Channel;
  user: User;
};

type ChannelLeaveResponse = {
  channelCode: string;
  userId: string;
  leftAt: Date;
};

type AudioLocation = {
  lat: number;
  lng: number;
  accuracy?: number;
};

type AudioMimeType = AudioMessage['mimeType'];

type LegacyAudioMessage = {
  channelCode?: string;
  fromUserId?: string;
  senderId?: string;
  fromNickname?: string;
  senderNickname?: string;
  payloadBase64?: string;
  audioBase64?: string;
  mimeType?: string;
  durationMs?: number;
  priority?: MessagePriority;
  location?: AudioLocation;
};

type SendAudioMessagePayload = {
  channelCode: string;
  senderId: string;
  senderNickname: string;
  audioBase64: string;
  mimeType: string;
  durationMs: number;
  priority: MessagePriority;
  location?: AudioLocation;
};

type AudioMessageOutbound = {
  id: string;
  channelCode: string;
  senderNickname: string;
  audioBase64: string;
  mimeType: string;
  priority: MessagePriority;
  timestamp: string;
  location?: AudioLocation;
};

type AudioAck =
  | { ok: true; data: { id: string; timestamp: string } }
  | {
      ok: false;
      error: string;
      code:
        | 'invalid_payload'
        | 'payload_too_large'
        | 'duration_exceeded'
        | 'rate_limited'
        | 'not_found'
        | 'unauthorized'
        | 'internal';
      retryAfterMs?: number;
    };

type EmergencyAck =
  | { ok: true; data: { broadcast: EmergencyBroadcast } }
  | { ok: false; error: string; code: string; retryAfterMs?: number };

export const createSocketService = (io: Server) => {
  const channels = new Map<string, ChannelState>();
  const socketIndex = new Map<string, { channelCode: string; userId: string }>();
  const audioRateLimit = new Map<string, { count: number; resetAt: number }>();
  const db = (() => {
    try {
      return new DatabaseService({ filename: DB_PATH, maxAudioBytes: MAX_AUDIO_BYTES });
    } catch (error) {
      console.error('[db] initialization failed', error);
      return null;
    }
  })();
  const emergencyService = createEmergencyService(io, {
    getUserContext: (socketId: string) => {
      const indexed = socketIndex.get(socketId);
      if (!indexed) {
        return null;
      }
      const channelState = channels.get(indexed.channelCode);
      if (!channelState) {
        return null;
      }
      const userState = channelState.users.get(indexed.userId);
      if (!userState) {
        return null;
      }
      return { user: userState.user, channelCode: indexed.channelCode };
    },
    touchActivity: (socketId: string) => {
      const indexed = socketIndex.get(socketId);
      if (!indexed) {
        return;
      }
      const channelState = channels.get(indexed.channelCode);
      if (!channelState) {
        return;
      }
      const userState = channelState.users.get(indexed.userId);
      if (!userState) {
        return;
      }
      const now = new Date();
      userState.lastActivityAt = now;
      channelState.lastActivityAt = now;
    },
  });

  const emitUserJoined = (channelCode: string, user: User) => {
    io.to(channelCode).emit('user:joined', { user });
  };

  const emitUserLeft = (channelCode: string, user: User, leftAt: Date) => {
    io.to(channelCode).emit('user:left', { user, leftAt });
  };

  const normalizeNickname = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_NICKNAME_LENGTH || trimmed.length > MAX_NICKNAME_LENGTH) {
      return null;
    }
    return trimmed;
  };

  const isValidChannelCode = (value: unknown): value is string => {
    return typeof value === 'string' && CHANNEL_CODE_REGEX.test(value);
  };

  const isValidPriority = (value: unknown): value is MessagePriority =>
    value === 'routine' || value === 'important' || value === 'urgent';

  const estimateBase64Bytes = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length % 4 !== 0) {
      return null;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      return null;
    }
    const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
  };

  const normalizeLocation = (value: unknown): AudioLocation | undefined => {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const location = value as { lat?: unknown; lng?: unknown; accuracy?: unknown };
    if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      return undefined;
    }
    if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      return undefined;
    }
    if (location.accuracy !== undefined && typeof location.accuracy !== 'number') {
      return undefined;
    }
    if (location.accuracy !== undefined && !Number.isFinite(location.accuracy)) {
      return undefined;
    }
    return {
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
    };
  };

  const normalizeMimeType = (value: string): AudioMimeType | null => {
    const base = value.split(';')[0]?.trim().toLowerCase();
    if (base === 'audio/webm' || base === 'audio/mp4') {
      return base;
    }
    return null;
  };

  const logAudioViolation = (socket: Socket, reason: string, details?: Record<string, unknown>) => {
    console.warn('[audio] violation', {
      reason,
      socketId: socket.id,
      ...details,
    });
  };

  const consumeAudioRateLimit = (userId: string) => {
    const now = Date.now();
    const entry = audioRateLimit.get(userId);
    if (!entry || now >= entry.resetAt) {
      audioRateLimit.set(userId, {
        count: 1,
        resetAt: now + AUDIO_RATE_LIMIT_WINDOW_MS,
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (entry.count >= AUDIO_RATE_LIMIT_MAX) {
      return { allowed: false, retryAfterMs: Math.max(0, entry.resetAt - now) };
    }

    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  };

  const decodeBase64Audio = (value: string, expectedBytes: number) => {
    try {
      const buffer = Buffer.from(value, 'base64');
      if (buffer.length !== expectedBytes) {
        return null;
      }
      const normalized = buffer.toString('base64').replace(/=+$/, '');
      const trimmed = value.trim().replace(/=+$/, '');
      if (normalized !== trimmed) {
        return null;
      }
      return buffer;
    } catch {
      return null;
    }
  };

  const respond = <T>(ack: ((response: AckResponse<T>) => void) | undefined, payload: AckResponse<T>) => {
    if (ack) {
      ack(payload);
    }
  };

  const createChannel = (channel: Channel): ChannelState => {
    const now = new Date();
    const state: ChannelState = {
      channel,
      users: new Map(),
      lastActivityAt: now,
    };

    channels.set(channel.code, state);
    db?.upsertChannel(channel, now);
    return state;
  };

  const buildChannel = (channelCode: string) => {
    const now = new Date();
    return {
      code: channelCode,
      displayName: `Channel ${channelCode}`,
      createdAt: now,
    } satisfies Channel;
  };

  const getOrCreateChannel = (channelCode: string): ChannelState => {
    const existing = channels.get(channelCode);
    if (existing) {
      return existing;
    }
    return createChannel(buildChannel(channelCode));
  };

  const generateChannelCode = (): string | null => {
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = String(randomInt(0, 10000)).padStart(4, '0');
      if (!channels.has(code)) {
        return code;
      }
    }
    return null;
  };

  const attachUserToChannel = (socket: Socket, channelState: ChannelState, nickname: string) => {
    const now = new Date();
    const user: User = {
      id: randomUUID(),
      nickname,
      channelCode: channelState.channel.code,
      joinedAt: now,
      connectionStatus: 'connected',
    };

    const userState: UserState = {
      user,
      socketId: socket.id,
      lastActivityAt: now,
    };

    channelState.users.set(user.id, userState);
    channelState.lastActivityAt = now;
    socketIndex.set(socket.id, { channelCode: channelState.channel.code, userId: user.id });
    socket.join(channelState.channel.code);

    return userState;
  };

  const removeUserFromChannel = (socket: Socket, reason: 'leave' | 'disconnect') => {
    const indexed = socketIndex.get(socket.id);
    if (!indexed) {
      return;
    }

    const channelState = channels.get(indexed.channelCode);
    if (!channelState) {
      socketIndex.delete(socket.id);
      audioRateLimit.delete(indexed.userId);
      return;
    }

    const userState = channelState.users.get(indexed.userId);
    if (!userState) {
      socketIndex.delete(socket.id);
      audioRateLimit.delete(indexed.userId);
      if (channelState.users.size === 0) {
        channels.delete(indexed.channelCode);
      }
      return;
    }

    const now = new Date();
    userState.user.connectionStatus = 'disconnected';
    userState.lastActivityAt = now;
    channelState.users.delete(indexed.userId);
    channelState.lastActivityAt = now;
    socketIndex.delete(socket.id);
    audioRateLimit.delete(indexed.userId);
    socket.leave(indexed.channelCode);

    emitUserLeft(indexed.channelCode, userState.user, now);

    if (channelState.users.size === 0) {
      channels.delete(indexed.channelCode);
    }
  };

  const handleCreate = (
    socket: Socket,
    payload: unknown,
    ack?: (response: AckResponse<ChannelCreateResponse>) => void,
  ) => {
    const nickname = normalizeNickname((payload as ChannelCreatePayload)?.nickname);
    if (!nickname) {
      respond(ack, { ok: false, error: 'Invalid nickname.', code: 'invalid_payload' });
      return;
    }

    const channelCode = generateChannelCode();
    if (!channelCode) {
      respond(ack, { ok: false, error: 'Unable to allocate channel.', code: 'internal' });
      return;
    }

    if (socketIndex.has(socket.id)) {
      removeUserFromChannel(socket, 'leave');
    }

    const channelState = getOrCreateChannel(channelCode);
    if (channelState.users.size >= MAX_USERS_PER_CHANNEL) {
      respond(ack, { ok: false, error: 'Channel full.', code: 'channel_full' });
      return;
    }

    const userState = attachUserToChannel(socket, channelState, nickname);
    emitUserJoined(channelCode, userState.user);
    respond(ack, { ok: true, data: { channel: channelState.channel, user: userState.user } });

    if (db) {
      try {
        db.upsertChannel(channelState.channel, new Date());
        const history = db.listRecentMessages(channelCode);
        if (history.length > 0) {
          const ordered = [...history].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
          const messages: AudioMessageOutbound[] = ordered.map((message) => ({
            id: message.id,
            channelCode: message.channelCode,
            senderNickname: message.fromNickname,
            audioBase64: message.payload.toString('base64'),
            mimeType: message.mimeType,
            priority: message.priority,
            timestamp: message.createdAt.toISOString(),
          }));
          socket.emit('audio-history', { messages });
        }
      } catch (error) {
        console.error('[audio] history load failed', error);
      }
    }
  };

  const handleJoin = (
    socket: Socket,
    payload: unknown,
    ack?: (response: AckResponse<ChannelJoinResponse>) => void,
  ) => {
    const channelCode = isValidChannelCode((payload as ChannelJoinPayload)?.channelCode)
      ? (payload as ChannelJoinPayload).channelCode
      : null;
    const nickname = normalizeNickname((payload as ChannelJoinPayload)?.nickname);

    if (!channelCode || !nickname) {
      respond(ack, { ok: false, error: 'Invalid channel code or nickname.', code: 'invalid_payload' });
      return;
    }

    let channelState = channels.get(channelCode);
    if (!channelState) {
      const channelRecord = db?.getChannelByCode(channelCode) ?? null;
      if (!channelRecord) {
        respond(ack, { ok: false, error: 'Channel not found.', code: 'not_found' });
        return;
      }
      channelState = {
        channel: channelRecord.channel,
        users: new Map(),
        lastActivityAt: channelRecord.lastActivityAt,
      };
      channels.set(channelCode, channelState);
    }

    if (channelState.users.size >= MAX_USERS_PER_CHANNEL) {
      respond(ack, { ok: false, error: 'Channel full.', code: 'channel_full' });
      return;
    }

    if (socketIndex.has(socket.id)) {
      removeUserFromChannel(socket, 'leave');
    }

    const userState = attachUserToChannel(socket, channelState, nickname);
    emitUserJoined(channelCode, userState.user);
    respond(ack, { ok: true, data: { channel: channelState.channel, user: userState.user } });
  };

  const handleLeave = (
    socket: Socket,
    payload: unknown,
    ack?: (response: AckResponse<ChannelLeaveResponse>) => void,
  ) => {
    const indexed = socketIndex.get(socket.id);
    if (!indexed) {
      respond(ack, { ok: false, error: 'Not in a channel.', code: 'not_found' });
      return;
    }

    const channelCode = isValidChannelCode((payload as ChannelLeavePayload)?.channelCode)
      ? (payload as ChannelLeavePayload).channelCode
      : indexed.channelCode;

    if (channelCode !== indexed.channelCode) {
      respond(ack, { ok: false, error: 'Invalid channel code.', code: 'invalid_payload' });
      return;
    }

    const channelState = channels.get(indexed.channelCode);
    if (!channelState) {
      socketIndex.delete(socket.id);
      respond(ack, { ok: false, error: 'Channel not found.', code: 'not_found' });
      return;
    }

    const userState = channelState.users.get(indexed.userId);
    const leftAt = new Date();

    removeUserFromChannel(socket, 'leave');

    respond(ack, {
      ok: true,
      data: {
        channelCode: indexed.channelCode,
        userId: userState?.user.id ?? indexed.userId,
        leftAt,
      },
    });
  };

  const handleActivity = (socket: Socket, payload: unknown) => {
    const indexed = socketIndex.get(socket.id);
    if (!indexed) {
      return;
    }

    const channelCode = isValidChannelCode((payload as { channelCode?: string })?.channelCode)
      ? (payload as { channelCode?: string }).channelCode
      : indexed.channelCode;

    if (channelCode !== indexed.channelCode) {
      return;
    }

    const channelState = channels.get(indexed.channelCode);
    if (!channelState) {
      return;
    }

    const userState = channelState.users.get(indexed.userId);
    if (!userState) {
      return;
    }

    const now = new Date();
    userState.lastActivityAt = now;
    channelState.lastActivityAt = now;
  };

  const handleSendAudioMessage = (
    socket: Socket,
    payload: unknown,
    ack?: (response: AudioAck) => void,
  ) => {
    const data = payload as SendAudioMessagePayload;
    if (
      !data ||
      !isValidChannelCode(data.channelCode) ||
      typeof data.senderId !== 'string' ||
      typeof data.senderNickname !== 'string' ||
      typeof data.audioBase64 !== 'string' ||
      typeof data.mimeType !== 'string' ||
      typeof data.durationMs !== 'number' ||
      !Number.isFinite(data.durationMs) ||
      !isValidPriority(data.priority)
    ) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'shape' });
      ack?.({ ok: false, error: 'Invalid audio payload.', code: 'invalid_payload' });
      return;
    }

    const rawMimeType = data.mimeType.trim().toLowerCase();
    const normalizedMimeType = normalizeMimeType(rawMimeType);
    if (!rawMimeType.startsWith('audio/') || !ALLOWED_MIME_TYPES.has(rawMimeType)) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'mime', mimeType: data.mimeType });
      ack?.({ ok: false, error: 'Unsupported mime type.', code: 'invalid_payload' });
      return;
    }
    if (!normalizedMimeType) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'mime', mimeType: data.mimeType });
      ack?.({ ok: false, error: 'Unsupported mime type.', code: 'invalid_payload' });
      return;
    }

    if (data.durationMs <= 0 || data.durationMs > MAX_AUDIO_DURATION_MS) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'duration', durationMs: data.durationMs });
      ack?.({ ok: false, error: 'Audio duration exceeds limit.', code: 'duration_exceeded' });
      return;
    }

    if (data.audioBase64.trim().length === 0) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'empty_audio' });
      ack?.({ ok: false, error: 'Invalid audio payload.', code: 'invalid_payload' });
      return;
    }

    const estimatedBytes = estimateBase64Bytes(data.audioBase64);
    if (estimatedBytes === null) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'base64_invalid' });
      ack?.({ ok: false, error: 'Invalid audio payload.', code: 'invalid_payload' });
      return;
    }
    if (estimatedBytes > MAX_AUDIO_BYTES) {
      logAudioViolation(socket, 'payload_too_large', { bytes: estimatedBytes });
      ack?.({ ok: false, error: 'Audio payload too large.', code: 'payload_too_large' });
      return;
    }

    const indexed = socketIndex.get(socket.id);
    if (!indexed) {
      logAudioViolation(socket, 'not_found', { stage: 'socket_index' });
      ack?.({ ok: false, error: 'Not in a channel.', code: 'not_found' });
      return;
    }
    if (indexed.channelCode !== data.channelCode) {
      logAudioViolation(socket, 'unauthorized', {
        stage: 'channel_mismatch',
        channelCode: data.channelCode,
      });
      ack?.({ ok: false, error: 'Unauthorized channel.', code: 'unauthorized' });
      return;
    }

    const channelState = channels.get(indexed.channelCode);
    if (!channelState) {
      logAudioViolation(socket, 'not_found', { stage: 'channel_state' });
      ack?.({ ok: false, error: 'Channel not found.', code: 'not_found' });
      return;
    }
    const userState = channelState.users.get(indexed.userId);
    if (!userState) {
      logAudioViolation(socket, 'not_found', { stage: 'user_state' });
      ack?.({ ok: false, error: 'User not found.', code: 'not_found' });
      return;
    }
    if (userState.user.id !== data.senderId) {
      logAudioViolation(socket, 'unauthorized', { stage: 'sender_id' });
      ack?.({ ok: false, error: 'Unauthorized sender.', code: 'unauthorized' });
      return;
    }

    const normalizedNickname = normalizeNickname(data.senderNickname);
    if (!normalizedNickname || normalizedNickname !== userState.user.nickname) {
      logAudioViolation(socket, 'unauthorized', { stage: 'nickname' });
      ack?.({ ok: false, error: 'Invalid sender nickname.', code: 'unauthorized' });
      return;
    }

    const location = normalizeLocation(data.location);
    if (data.location && !location) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'location' });
      ack?.({ ok: false, error: 'Invalid location.', code: 'invalid_payload' });
      return;
    }

    const rateLimit = consumeAudioRateLimit(userState.user.id);
    if (!rateLimit.allowed) {
      logAudioViolation(socket, 'rate_limited', { userId: userState.user.id });
      ack?.({
        ok: false,
        error: 'Rate limited. Try again shortly.',
        code: 'rate_limited',
        retryAfterMs: rateLimit.retryAfterMs,
      });
      return;
    }

    const buffer = decodeBase64Audio(data.audioBase64, estimatedBytes);
    if (!buffer || buffer.length === 0) {
      logAudioViolation(socket, 'invalid_payload', { stage: 'decode' });
      ack?.({ ok: false, error: 'Invalid audio payload.', code: 'invalid_payload' });
      return;
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      logAudioViolation(socket, 'payload_too_large', { bytes: buffer.length });
      ack?.({ ok: false, error: 'Audio payload too large.', code: 'payload_too_large' });
      return;
    }

    const createdAt = new Date();
    const outbound: AudioMessageOutbound = {
      id: randomUUID(),
      channelCode: data.channelCode,
      senderNickname: userState.user.nickname,
      audioBase64: data.audioBase64,
      mimeType: normalizedMimeType,
      priority: data.priority,
      timestamp: createdAt.toISOString(),
      location,
    };

    if (!db) {
      logAudioViolation(socket, 'internal', { stage: 'db_unavailable' });
      ack?.({ ok: false, error: 'Storage unavailable.', code: 'internal' });
      return;
    }

    try {
      db.upsertChannel(channelState.channel, createdAt);
      db.recordAudioMessage({
        id: outbound.id,
        channelCode: data.channelCode,
        fromUserId: userState.user.id,
        fromNickname: userState.user.nickname,
        createdAt,
        priority: data.priority,
        mimeType: normalizedMimeType,
        durationMs: data.durationMs,
        sizeBytes: buffer.length,
        payload: buffer,
      });
    } catch (error) {
      logAudioViolation(socket, 'internal', {
        stage: 'db_write',
        error: error instanceof Error ? error.message : String(error),
      });
      ack?.({ ok: false, error: 'Unable to store audio.', code: 'internal' });
      return;
    }

    const now = new Date();
    userState.lastActivityAt = now;
    channelState.lastActivityAt = now;

    io.to(data.channelCode).emit('audio-message', outbound);
    io.to(data.channelCode).emit('audio:message', { message: outbound });

    if (ack) {
      ack({ ok: true, data: { id: outbound.id, timestamp: outbound.timestamp } });
    }
  };

  io.on('connection', (socket) => {
    socket.on('channel:create', (payload, ack) => {
      handleCreate(socket, payload, ack);
    });

    socket.on('channel:join', (payload, ack) => {
      handleJoin(socket, payload, ack);
    });

    socket.on('channel:leave', (payload, ack) => {
      handleLeave(socket, payload, ack);
    });

    socket.on('user:activity', (payload) => {
      handleActivity(socket, payload);
    });

    socket.on('send-audio-message', (payload, ack) => {
      handleSendAudioMessage(socket, payload, ack);
    });

    socket.on('audio:send', (payload, ack) => {
      const legacy = payload as { message?: unknown };
      const message = legacy?.message as LegacyAudioMessage | undefined;
      if (!message) {
        handleSendAudioMessage(socket, payload, ack);
        return;
      }
      const senderId = message.fromUserId ?? message.senderId;
      const senderNickname = message.fromNickname ?? message.senderNickname;
      const audioBase64 = message.payloadBase64 ?? message.audioBase64;
      if (
        !message.channelCode ||
        !senderId ||
        !senderNickname ||
        !audioBase64 ||
        !message.mimeType ||
        message.durationMs === undefined ||
        !message.priority
      ) {
        handleSendAudioMessage(socket, payload, ack);
        return;
      }
      handleSendAudioMessage(
        socket,
        {
          channelCode: message.channelCode,
          senderId,
          senderNickname,
          audioBase64,
          mimeType: message.mimeType,
          durationMs: message.durationMs,
          priority: message.priority,
          location: message.location,
        } satisfies SendAudioMessagePayload,
        ack,
      );
    });

    socket.on('emergency:broadcast', (payload, ack) => {
      const wrappedAck = (response: EmergencyAck) => {
        if (response?.ok && db) {
          try {
            db.recordEmergency(response.data.broadcast);
          } catch (error) {
            console.error('[emergency] log failed', error);
          }
        }
        ack?.(response);
      };
      emergencyService.handleBroadcast(socket, payload, ack ? wrappedAck : undefined);
    });

    socket.on('disconnect', () => {
      removeUserFromChannel(socket, 'disconnect');
    });
  });
};
