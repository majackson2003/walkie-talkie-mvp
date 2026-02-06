import type { ConnectionStatus } from '@walkie/shared/types';

type ConnectionQuality = 'good' | 'ok' | 'poor' | 'offline';
type UserPresence = 'active' | 'idle' | 'away';

export type BatteryInfo = {
  supported: boolean;
  level: number | null;
  charging: boolean | null;
};

type StatusBarProps = {
  connectionStatus: ConnectionStatus;
  quality: ConnectionQuality;
  latencyMs: number | null;
  presence: UserPresence;
  queuedCount: number;
  battery: BatteryInfo;
};

const qualityColor = (quality: ConnectionQuality) => {
  if (quality === 'good') return 'text-emerald-300';
  if (quality === 'ok') return 'text-amber-300';
  if (quality === 'poor') return 'text-rose-300';
  return 'text-slate-300';
};

const formatLatency = (latencyMs: number | null) => {
  if (latencyMs === null) return '—';
  return `${latencyMs}ms`;
};

const formatBattery = (battery: BatteryInfo) => {
  if (!battery.supported) return 'Battery: N/A';
  if (battery.level === null) return 'Battery: —';
  const percent = Math.round(battery.level * 100);
  const charging = battery.charging ? ' (Charging)' : '';
  return `Battery: ${percent}%${charging}`;
};

export const StatusBar = ({
  connectionStatus,
  quality,
  latencyMs,
  presence,
  queuedCount,
  battery,
}: StatusBarProps) => {
  return (
    <div className="w-full rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-100">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-slate-300">Status:</span>
          <span className="capitalize">{connectionStatus}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300">Quality:</span>
          <span className={qualityColor(quality)}>{quality}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300">Latency:</span>
          <span>{formatLatency(latencyMs)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300">Presence:</span>
          <span className="capitalize">{presence}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300">Queue:</span>
          <span>{queuedCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-300">{formatBattery(battery)}</span>
        </div>
      </div>
    </div>
  );
};
