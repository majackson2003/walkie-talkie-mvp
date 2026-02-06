import { useEffect, useState } from 'react';
import { socket } from './socket';
import type { ChannelCode, Nickname } from '@walkie/shared';

export default function App() {
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  const channel: ChannelCode = 'demo';
  const nickname: Nickname = 'operator';

  return (
    <main className="min-h-screen px-6 py-10">
      <h1 className="text-2xl font-semibold">Walkie Talkie</h1>
      <p className="mt-2 text-sm text-slate-300">Status: {status}</p>
      <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
        <p className="text-sm text-slate-300">Channel: {channel}</p>
        <p className="text-sm text-slate-300">Nickname: {nickname}</p>
      </div>
    </main>
  );
}
