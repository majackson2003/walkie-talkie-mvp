import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { AudioMessage, Channel, EmergencyBroadcast, MessagePriority } from '@walkie/shared/types';

type AudioMimeType = AudioMessage['mimeType'];
type Statement<T extends Record<string, unknown> = Record<string, unknown>, R = unknown> =
  Database.Statement<[T], R>;

type DatabaseServiceOptions = {
  filename: string;
  schemaPath?: string;
  maxAudioBytes?: number;
};

type ChannelRow = {
  code: string;
  display_name: string;
  created_at: number;
  last_activity_at: number;
};

type MessageRow = {
  id: string;
  channel_code: string;
  from_user_id: string;
  from_nickname: string;
  created_at: number;
  priority: MessagePriority;
  mime_type: AudioMimeType;
  duration_ms: number;
  size_bytes: number;
  payload: Buffer;
};

type EmergencyRow = {
  id: string;
  channel_code: string;
  from_user_id: string;
  from_nickname: string;
  created_at: number;
  priority: MessagePriority;
  message: string;
};

type AudioMessageRecord = Omit<AudioMessage, 'payloadBase64'> & { payload: Buffer };

const DEFAULT_MAX_AUDIO_BYTES = 1_000_000;

export class DatabaseService {
  private readonly db: Database.Database;
  private readonly maxAudioBytes: number;

  private readonly insertChannelStmt: Statement<ChannelRow>;
  private readonly getChannelByCodeStmt: Statement<{ code: string }>;
  private readonly updateChannelActivityStmt: Statement<{ code: string; last_activity_at: number }>;
  private readonly insertMessageStmt: Statement<MessageRow>;
  private readonly pruneMessagesStmt: Statement<{ channel_code: string }>;
  private readonly listRecentMessagesStmt: Statement<{ channel_code: string; limit: number }>;
  private readonly listChannelCodesStmt: Database.Statement<[]>;
  private readonly deleteOldMessagesStmt: Statement<{ cutoff: number }>;
  private readonly deleteOldEmergencyStmt: Statement<{ cutoff: number }>;
  private readonly deleteIdleChannelsStmt: Statement<{ cutoff: number }>;
  private readonly insertEmergencyStmt: Statement<EmergencyRow>;

  private readonly insertMessageTx: (row: MessageRow) => void;

  constructor(options: DatabaseServiceOptions) {
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    const filename = options.filename;
    if (filename !== ':memory:') {
      const resolved = path.resolve(filename);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(resolved);
    } else {
      this.db = new Database(filename);
    }
    this.configureDatabase();
    this.applySchema(options.schemaPath);

    this.insertChannelStmt = this.db.prepare(
      `INSERT INTO channels (code, display_name, created_at, last_activity_at)
       VALUES (@code, @display_name, @created_at, @last_activity_at)
       ON CONFLICT(code) DO UPDATE SET
         display_name = excluded.display_name,
         last_activity_at = excluded.last_activity_at`,
    );
    this.getChannelByCodeStmt = this.db.prepare(
      `SELECT code, display_name, created_at, last_activity_at
       FROM channels
       WHERE code = @code`,
    );
    this.updateChannelActivityStmt = this.db.prepare(
      `UPDATE channels SET last_activity_at = @last_activity_at WHERE code = @code`,
    );
    this.insertMessageStmt = this.db.prepare(
      `INSERT INTO messages (
        id, channel_code, from_user_id, from_nickname, created_at, priority, mime_type,
        duration_ms, size_bytes, payload
      ) VALUES (
        @id, @channel_code, @from_user_id, @from_nickname, @created_at, @priority, @mime_type,
        @duration_ms, @size_bytes, @payload
      )`,
    );
    this.pruneMessagesStmt = this.db.prepare(
      `DELETE FROM messages
       WHERE id IN (
         SELECT id FROM messages
         WHERE channel_code = @channel_code
         ORDER BY created_at DESC
         LIMIT -1 OFFSET 50
       )`,
    );
    this.listRecentMessagesStmt = this.db.prepare(
      `SELECT id, channel_code, from_user_id, from_nickname, created_at, priority, mime_type,
              duration_ms, size_bytes, payload
       FROM messages
       WHERE channel_code = @channel_code
       ORDER BY created_at DESC
       LIMIT @limit`,
    );
    this.listChannelCodesStmt = this.db.prepare(`SELECT code FROM channels`);
    this.deleteOldMessagesStmt = this.db.prepare(`DELETE FROM messages WHERE created_at < @cutoff`);
    this.deleteOldEmergencyStmt = this.db.prepare(`DELETE FROM emergency_log WHERE created_at < @cutoff`);
    this.deleteIdleChannelsStmt = this.db.prepare(
      `DELETE FROM channels WHERE last_activity_at < @cutoff`,
    );
    this.insertEmergencyStmt = this.db.prepare(
      `INSERT INTO emergency_log (
        id, channel_code, from_user_id, from_nickname, created_at, priority, message
      ) VALUES (
        @id, @channel_code, @from_user_id, @from_nickname, @created_at, @priority, @message
      )`,
    );

    this.insertMessageTx = this.db.transaction((row: MessageRow) => {
      this.insertMessageStmt.run(row);
      this.pruneMessagesStmt.run({ channel_code: row.channel_code });
      this.updateChannelActivityStmt.run({
        code: row.channel_code,
        last_activity_at: row.created_at,
      });
    });
  }

  close() {
    this.db.close();
  }

  upsertChannel(channel: Channel, lastActivityAt?: Date) {
    const lastActivity = lastActivityAt ?? channel.createdAt;
    const row: ChannelRow = {
      code: channel.code,
      display_name: channel.displayName,
      created_at: channel.createdAt.getTime(),
      last_activity_at: lastActivity.getTime(),
    };
    this.insertChannelStmt.run(row);
  }

  getChannelByCode(code: string): { channel: Channel; lastActivityAt: Date } | null {
    const row = this.getChannelByCodeStmt.get({ code }) as ChannelRow | undefined;
    if (!row) {
      return null;
    }
    return {
      channel: {
        code: row.code,
        displayName: row.display_name,
        createdAt: new Date(row.created_at),
      },
      lastActivityAt: new Date(row.last_activity_at),
    };
  }

  touchChannel(code: string, when = new Date()) {
    this.updateChannelActivityStmt.run({ code, last_activity_at: when.getTime() });
  }

  recordAudioMessage(message: AudioMessageRecord) {
    if (message.sizeBytes !== message.payload.length) {
      throw new Error('Audio sizeBytes does not match payload length.');
    }
    if (message.payload.length > this.maxAudioBytes) {
      throw new Error(`Audio payload exceeds ${this.maxAudioBytes} bytes.`);
    }

    const row: MessageRow = {
      id: message.id,
      channel_code: message.channelCode,
      from_user_id: message.fromUserId,
      from_nickname: message.fromNickname,
      created_at: message.createdAt.getTime(),
      priority: message.priority,
      mime_type: message.mimeType,
      duration_ms: message.durationMs,
      size_bytes: message.sizeBytes,
      payload: message.payload,
    };

    this.insertMessageTx(row);
  }

  recordEmergency(broadcast: EmergencyBroadcast) {
    const row: EmergencyRow = {
      id: broadcast.id,
      channel_code: broadcast.channelCode,
      from_user_id: broadcast.fromUserId,
      from_nickname: broadcast.fromNickname,
      created_at: broadcast.createdAt.getTime(),
      priority: broadcast.priority,
      message: broadcast.message,
    };
    this.insertEmergencyStmt.run(row);
    this.updateChannelActivityStmt.run({
      code: broadcast.channelCode,
      last_activity_at: broadcast.createdAt.getTime(),
    });
  }

  listRecentMessages(channelCode: string, limit = 50): AudioMessageRecord[] {
    const boundedLimit = Math.max(0, Math.min(limit, 50));
    if (boundedLimit === 0) {
      return [];
    }
    const rows = this.listRecentMessagesStmt.all({
      channel_code: channelCode,
      limit: boundedLimit,
    }) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      channelCode: row.channel_code,
      fromUserId: row.from_user_id,
      fromNickname: row.from_nickname,
      createdAt: new Date(row.created_at),
      priority: row.priority,
      mimeType: row.mime_type,
      durationMs: row.duration_ms,
      sizeBytes: row.size_bytes,
      payload: row.payload,
    }));
  }

  pruneMessagesForChannel(channelCode: string) {
    return this.pruneMessagesStmt.run({ channel_code: channelCode }).changes;
  }

  pruneMessagesForAllChannels() {
    const channels = this.listChannelCodesStmt.all() as { code: string }[];
    let total = 0;
    const tx = this.db.transaction(() => {
      channels.forEach((channel) => {
        total += this.pruneMessagesStmt.run({ channel_code: channel.code }).changes;
      });
    });
    tx();
    return total;
  }

  cleanupOldMessages(cutoff: Date) {
    return this.deleteOldMessagesStmt.run({ cutoff: cutoff.getTime() }).changes;
  }

  cleanupOldEmergencyLogs(cutoff: Date) {
    return this.deleteOldEmergencyStmt.run({ cutoff: cutoff.getTime() }).changes;
  }

  cleanupIdleChannels(cutoff: Date) {
    return this.deleteIdleChannelsStmt.run({ cutoff: cutoff.getTime() }).changes;
  }

  private configureDatabase() {
    this.db.prepare('PRAGMA journal_mode = WAL').run();
    this.db.prepare('PRAGMA synchronous = NORMAL').run();
    this.db.prepare('PRAGMA foreign_keys = ON').run();
    this.db.prepare('PRAGMA busy_timeout = 5000').run();
  }

  private applySchema(schemaPath?: string) {
    const resolvedPath =
      schemaPath ?? path.resolve(process.cwd(), 'schema.sql');
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Schema file not found at ${resolvedPath}`);
    }
    const schema = fs.readFileSync(resolvedPath, 'utf-8');
    const statements = schema
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    statements.forEach((statement) => {
      this.db.prepare(statement).run();
    });
  }
}
