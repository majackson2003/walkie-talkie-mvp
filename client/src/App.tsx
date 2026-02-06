import { type FormEvent, useMemo, useState } from 'react';
import type { ChannelCode, Nickname } from '@walkie/shared';
import { ChannelScreen } from './screens/ChannelScreen';
import { SocketService } from './services/socketService';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (import.meta.env.PROD ? window.location.origin : 'http://localhost:3001');

type ScreenState =
  | { screen: 'join' }
  | { screen: 'channel'; channelCode: ChannelCode; nickname: Nickname };

export default function App() {
  const socketService = useMemo(() => new SocketService(SERVER_URL), []);
  const [screen, setScreen] = useState<ScreenState>({ screen: 'join' });
  const [channelCode, setChannelCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const code = channelCode.replace(/\D/g, '').slice(0, 4);
    const name = nickname.trim();
    if (code.length !== 4) {
      setError('Enter a 4-digit channel code.');
      return;
    }
    if (name.length < 1) {
      setError('Enter a nickname.');
      return;
    }
    setScreen({ screen: 'channel', channelCode: code, nickname: name });
  };

  const handleCreate = async () => {
    setError(null);
    const name = nickname.trim();
    if (name.length < 1) {
      setError('Enter a nickname.');
      return;
    }
    setIsSubmitting(true);
    try {
      socketService.connect();
      const response = await socketService.createChannel({ nickname: name });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setScreen({
        screen: 'channel',
        channelCode: response.data.channel.code,
        nickname: response.data.user.nickname,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create channel.';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (screen.screen === 'channel') {
    return (
      <ChannelScreen
        socketService={socketService}
        channelCode={screen.channelCode}
        nickname={screen.nickname}
      />
    );
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Walkie Talkie</h1>
          <p className="mt-2 text-sm text-slate-300">
            Enter a 4-digit channel code or create a new channel.
          </p>
        </div>

        <form onSubmit={handleJoin} className="flex flex-col gap-4">
          <label className="flex flex-col gap-2 text-sm text-slate-200">
            Nickname
            <input
              type="text"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={24}
              className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-base text-white"
              placeholder="Operator"
              required
            />
          </label>

          <label className="flex flex-col gap-2 text-sm text-slate-200">
            Channel Code
            <input
              type="text"
              inputMode="numeric"
              pattern="\\d{4}"
              value={channelCode}
              onChange={(event) => setChannelCode(event.target.value)}
              maxLength={4}
              className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-base text-white"
              placeholder="1234"
            />
          </label>

          {error ? <div className="text-sm text-red-300">{error}</div> : null}

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className="rounded-2xl bg-sky-600 px-4 py-3 text-base font-semibold text-white"
            >
              Join Channel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isSubmitting}
              className="rounded-2xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-base font-semibold text-slate-100"
            >
              {isSubmitting ? 'Creating…' : 'Create New Channel'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
