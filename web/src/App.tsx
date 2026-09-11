import { useEffect, useState } from 'react';
import { getHealth } from './lib/api';

type ConnectionState =
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    getHealth(controller.signal)
      .then(({ status }) => {
        if (status === 'ok') {
          setConnection({ kind: 'success' });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        setConnection({
          kind: 'error',
          message: error instanceof Error ? error.message : '无法连接到后端服务',
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <section className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.3em] text-cyan-400">Dropoint</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">全栈项目脚手架</h1>
        <p className="mt-3 text-slate-400">Vite + React + Tailwind CSS / Axum + Tokio</p>

        <div className="mt-8 rounded-xl border border-slate-700 bg-slate-950/60 p-5">
          <p className="text-sm text-slate-400">后端连接状态</p>
          {connection.kind === 'loading' && <p className="mt-2 text-amber-300">正在检查后端……</p>}
          {connection.kind === 'success' && <p className="mt-2 text-emerald-300">后端连接正常</p>}
          {connection.kind === 'error' && <p className="mt-2 text-rose-300">{connection.message}</p>}
        </div>
      </section>
    </main>
  );
}
