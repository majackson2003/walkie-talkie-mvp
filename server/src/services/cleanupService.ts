import { DatabaseService } from './databaseService';

type CleanupOptions = {
  intervalMs?: number;
  messageRetentionDays?: number;
  emergencyRetentionDays?: number;
  channelIdleDays?: number;
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MESSAGE_RETENTION_DAYS = 7;
const DEFAULT_EMERGENCY_RETENTION_DAYS = 30;
const DEFAULT_CHANNEL_IDLE_DAYS = 3;

export const startCleanupJobs = (db: DatabaseService, options: CleanupOptions = {}) => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const messageRetentionDays = options.messageRetentionDays ?? DEFAULT_MESSAGE_RETENTION_DAYS;
  const emergencyRetentionDays = options.emergencyRetentionDays ?? DEFAULT_EMERGENCY_RETENTION_DAYS;
  const channelIdleDays = options.channelIdleDays ?? DEFAULT_CHANNEL_IDLE_DAYS;

  const runCleanup = () => {
    const now = Date.now();
    db.pruneMessagesForAllChannels();
    db.cleanupOldMessages(new Date(now - messageRetentionDays * 24 * 60 * 60 * 1000));
    db.cleanupOldEmergencyLogs(new Date(now - emergencyRetentionDays * 24 * 60 * 60 * 1000));
    db.cleanupIdleChannels(new Date(now - channelIdleDays * 24 * 60 * 60 * 1000));
  };

  runCleanup();
  const timer = setInterval(runCleanup, intervalMs);

  return () => {
    clearInterval(timer);
  };
};
