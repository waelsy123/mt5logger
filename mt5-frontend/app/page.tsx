'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Account {
  account_id: string;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  daily_pnl: number;
  unrealized_pnl: number;
  currency: string;
  snapshot_time: string;
}

interface WsEvent {
  id: string;
  type: 'deal' | 'order' | 'account';
  data: Record<string, unknown>;
  timestamp: number;
}

export default function Dashboard() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_MT5_API_URL || 'http://localhost:3001';

  const fetchAccounts = async () => {
    try {
      const res = await fetch(`${apiUrl}/accounts`);
      if (!res.ok) throw new Error('Failed to fetch accounts');
      const data = await res.json();
      setAccounts(data.accounts || []);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
      setError('Failed to connect to MT5 Logger service');
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const newEvent: WsEvent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: msg.type,
          data: msg.data,
          timestamp: Date.now(),
        };
        setEvents(prev => [newEvent, ...prev].slice(0, 50));

        if (msg.type === 'account' && msg.data) {
          setAccounts(prev => {
            const idx = prev.findIndex(a => a.account_id === msg.data.account_id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], ...msg.data };
              return updated;
            }
            return [...prev, msg.data as Account];
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      reconnectRef.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {};
  };

  useEffect(() => {
    fetchAccounts();
    connectWebSocket();
    const interval = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, []);

  const formatCurrency = (val: number | string, currency: string) => {
    const n = Number(val) || 0;
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
  };

  const formatPnl = (val: number | string) => {
    const n = Number(val) || 0;
    const sign = n >= 0 ? '+' : '';
    return sign + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const getStatusDot = (snapshotTime: string) => {
    const diff = now - new Date(snapshotTime).getTime();
    if (diff < 60000) return 'bg-green-500 animate-pulse';
    if (diff < 300000) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getStatusText = (snapshotTime: string) => {
    const diff = now - new Date(snapshotTime).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(snapshotTime).toLocaleDateString();
  };

  const getEventBadge = (type: string) => {
    switch (type) {
      case 'deal': return 'text-green-400 bg-green-500/10 ring-green-500/30';
      case 'order': return 'text-blue-400 bg-blue-500/10 ring-blue-500/30';
      case 'account': return 'text-purple-400 bg-purple-500/10 ring-purple-500/30';
      default: return 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/30';
    }
  };

  const formatEventTime = (ts: number) => {
    const diff = now - ts;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(ts).toLocaleTimeString();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                </div>
                <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-blue-500 to-cyan-500 bg-clip-text text-transparent">
                  MT5 Trading Dashboard
                </h1>
              </div>
              <p className="text-zinc-400 text-base sm:text-lg">
                Real-time MetaTrader 5 account monitoring and trade tracking.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Link
                href="/copy-trading"
                className="flex items-center gap-2 px-4 py-2 rounded-lg ring-1 bg-orange-500/10 text-orange-400 ring-orange-500/30 hover:bg-orange-500/20 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <span className="text-sm font-medium">Copy Trading</span>
              </Link>
              <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ring-1 ${
                wsConnected
                  ? 'bg-green-500/10 text-green-400 ring-green-500/30'
                  : 'bg-red-500/10 text-red-400 ring-red-500/30'
              }`}>
                <div className={`w-2 h-2 rounded-full ${
                  wsConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                }`} />
                <span className="text-sm font-medium">{wsConnected ? 'Connected' : 'Disconnected'}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="text-zinc-500 flex items-center gap-2">
              <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Loading accounts...
            </div>
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-red-500/20">
              <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2 text-white">{error}</h3>
            <p className="text-zinc-400 text-sm mb-4">Make sure the mt5-logger service is running</p>
            <button
              onClick={() => { setError(null); setLoading(true); fetchAccounts(); }}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg transition-colors text-sm"
            >
              Retry
            </button>
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-zinc-700">
              <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2 text-white">No accounts found</h3>
            <p className="text-zinc-400 text-sm">No MT5 accounts are being monitored yet.</p>
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Account Cards */}
            <div className="flex-1">
              <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {accounts.map((account) => (
                  <button
                    key={account.account_id}
                    onClick={() => router.push(`/${account.account_id}`)}
                    className="group relative bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-6 border border-white/10 hover:border-blue-500/30 transition-all duration-300 hover:scale-[1.02] text-left"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-cyan-500/5 opacity-0 group-hover:opacity-100 rounded-2xl transition-opacity duration-300" />

                    <div className="relative">
                      {/* Account ID + Status */}
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center ring-2 ring-white/10 group-hover:ring-blue-500/30 transition-all">
                            <span className="text-white font-bold text-sm">MT5</span>
                          </div>
                          <div>
                            <h2 className="font-bold text-lg text-white">{account.account_id}</h2>
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 ring-1 ring-zinc-700">
                              {account.currency}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className={`w-2 h-2 rounded-full ${getStatusDot(account.snapshot_time)}`} />
                          <span className="text-xs text-zinc-500">{getStatusText(account.snapshot_time)}</span>
                        </div>
                      </div>

                      {/* Balance & Equity */}
                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <div>
                          <p className="text-xs text-zinc-500 mb-1">Balance</p>
                          <p className="text-lg font-bold text-white">{formatCurrency(account.balance, account.currency)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-500 mb-1">Equity</p>
                          <p className="text-lg font-bold text-white">{formatCurrency(account.equity, account.currency)}</p>
                        </div>
                      </div>

                      {/* PnL */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-zinc-800/50 rounded-lg p-3">
                          <p className="text-xs text-zinc-500 mb-1">Daily PnL</p>
                          <p className={`text-sm font-bold ${Number(account.daily_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnl(account.daily_pnl)}
                          </p>
                        </div>
                        <div className="bg-zinc-800/50 rounded-lg p-3">
                          <p className="text-xs text-zinc-500 mb-1">Unrealized PnL</p>
                          <p className={`text-sm font-bold ${Number(account.unrealized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnl(account.unrealized_pnl)}
                          </p>
                        </div>
                      </div>

                      {/* Arrow */}
                      <div className="mt-4 flex justify-end">
                        <svg className="w-4 h-4 text-zinc-600 group-hover:text-blue-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Live Events Sidebar */}
            <div className="lg:w-80 shrink-0">
              <div className="sticky top-8">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  <h2 className="text-lg font-bold text-white">Live Events</h2>
                  <span className="text-xs text-zinc-500 ml-2">{events.length} recent</span>
                </div>
                <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl border border-white/10 overflow-hidden max-h-[600px] overflow-y-auto">
                  {events.length === 0 ? (
                    <div className="px-5 py-8 text-center">
                      <p className="text-sm text-zinc-500">No events yet</p>
                      <p className="text-xs text-zinc-600 mt-1">Events will appear here in real-time</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-zinc-800/50">
                      {events.map((event) => (
                        <div key={event.id} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors animate-slideIn">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getEventBadge(event.type)}`}>
                              {event.type}
                            </span>
                            {event.data?.symbol ? (
                              <span className="text-xs text-zinc-400 font-mono">{String(event.data.symbol)}</span>
                            ) : null}
                            <span className="text-xs text-zinc-600 ml-auto">{formatEventTime(event.timestamp)}</span>
                          </div>
                          {event.type === 'deal' && event.data?.profit !== undefined ? (
                            <p className={`text-sm font-medium ${Number(event.data.profit) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {formatPnl(Number(event.data.profit))}
                            </p>
                          ) : null}
                          {event.type === 'account' && event.data?.account_id ? (
                            <p className="text-xs text-zinc-500">Account {String(event.data.account_id)}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
