'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';

interface Account {
  account_id: string;
}

interface CopyConfig {
  id: number;
  source_account_id: number;
  dest_account_id: number;
  volume_multiplier: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface CopySignal {
  id: number;
  config_id: number;
  source_account_id: number;
  dest_account_id: number;
  signal_type: string;
  symbol: string;
  direction: string;
  volume: number;
  status: string;
  error_message: string | null;
  created_at: string;
  executed_at: string | null;
}

interface ExecutorStatus {
  account_id: number;
  connected: boolean;
  last_heartbeat: string;
}

export default function CopyTradingPage() {
  const apiUrl = process.env.NEXT_PUBLIC_MT5_API_URL || 'http://localhost:3001';

  const [configs, setConfigs] = useState<CopyConfig[]>([]);
  const [signals, setSignals] = useState<CopySignal[]>([]);
  const [executors, setExecutors] = useState<ExecutorStatus[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<CopyConfig | null>(null);
  const [formSource, setFormSource] = useState('');
  const [formDest, setFormDest] = useState('');
  const [formMultiplier, setFormMultiplier] = useState('1.0');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [configRes, signalRes, execRes, accountRes] = await Promise.all([
        fetch(`${apiUrl}/copy/configs`),
        fetch(`${apiUrl}/copy/signals?limit=50`),
        fetch(`${apiUrl}/copy/executor/status`),
        fetch(`${apiUrl}/accounts`),
      ]);

      const configData = await configRes.json();
      const signalData = await signalRes.json();
      const execData = await execRes.json();
      const accountData = await accountRes.json();

      setConfigs(configData.configs || []);
      setSignals(signalData.signals || []);
      setExecutors(execData.executors || []);
      setAccounts(accountData.accounts || []);
    } catch (err) {
      console.error('Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  const connectWebSocket = useCallback(() => {
    const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'copy_signal_result') {
          // Refresh signals when we get a result
          fetch(`${apiUrl}/copy/signals?limit=50`)
            .then(res => res.json())
            .then(data => setSignals(data.signals || []))
            .catch(() => {});
        }
      } catch {}
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      reconnectRef.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {};
  }, [apiUrl]);

  useEffect(() => {
    fetchAll();
    connectWebSocket();
    const interval = setInterval(fetchAll, 10000);

    return () => {
      clearInterval(interval);
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [fetchAll, connectWebSocket]);

  const handleCreateConfig = async () => {
    if (!formSource || !formDest) return;
    try {
      await fetch(`${apiUrl}/copy/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_account_id: Number(formSource),
          dest_account_id: Number(formDest),
          volume_multiplier: Number(formMultiplier),
        }),
      });
      setShowForm(false);
      resetForm();
      fetchAll();
    } catch (err) {
      console.error('Failed to create config:', err);
    }
  };

  const handleUpdateConfig = async () => {
    if (!editingConfig) return;
    try {
      await fetch(`${apiUrl}/copy/configs/${editingConfig.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volume_multiplier: Number(formMultiplier),
          enabled: editingConfig.enabled,
        }),
      });
      setEditingConfig(null);
      resetForm();
      fetchAll();
    } catch (err) {
      console.error('Failed to update config:', err);
    }
  };

  const handleToggleEnabled = async (config: CopyConfig) => {
    try {
      await fetch(`${apiUrl}/copy/configs/${config.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !config.enabled }),
      });
      fetchAll();
    } catch (err) {
      console.error('Failed to toggle config:', err);
    }
  };

  const handleDeleteConfig = async (id: number) => {
    if (!confirm('Delete this copy config?')) return;
    try {
      await fetch(`${apiUrl}/copy/configs/${id}`, { method: 'DELETE' });
      fetchAll();
    } catch (err) {
      console.error('Failed to delete config:', err);
    }
  };

  const resetForm = () => {
    setFormSource('');
    setFormDest('');
    setFormMultiplier('1.0');
    setShowForm(false);
    setEditingConfig(null);
  };

  const startEdit = (config: CopyConfig) => {
    setEditingConfig(config);
    setFormMultiplier(String(config.volume_multiplier));
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'filled': return 'text-green-400 bg-green-500/10 ring-green-500/30';
      case 'sent': return 'text-blue-400 bg-blue-500/10 ring-blue-500/30';
      case 'pending': return 'text-yellow-400 bg-yellow-500/10 ring-yellow-500/30';
      case 'failed': return 'text-red-400 bg-red-500/10 ring-red-500/30';
      default: return 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/30';
    }
  };

  const getSignalTypeBadge = (type: string) => {
    switch (type) {
      case 'open': return 'text-green-400 bg-green-500/10 ring-green-500/30';
      case 'close': return 'text-red-400 bg-red-500/10 ring-red-500/30';
      case 'modify': return 'text-purple-400 bg-purple-500/10 ring-purple-500/30';
      default: return 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/30';
    }
  };

  const isExecutorConnected = (accountId: number) => {
    return executors.some(e => e.account_id === accountId && e.connected);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white flex items-center justify-center">
        <div className="text-zinc-500 flex items-center gap-2">
          <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <Link href="/" className="text-zinc-400 hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </Link>
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </div>
                <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-orange-500 to-amber-500 bg-clip-text text-transparent">
                  Copy Trading
                </h1>
              </div>
              <p className="text-zinc-400 text-base sm:text-lg">
                Manage copy trading configurations between MT5 accounts.
              </p>
            </div>

            <div className="flex items-center gap-3">
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

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Executor Status */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Executor Status</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {executors.length === 0 ? (
              <div className="col-span-full bg-zinc-900/50 rounded-xl border border-white/10 p-6 text-center text-zinc-500 text-sm">
                No executors registered
              </div>
            ) : (
              executors.map((exec) => (
                <div key={exec.account_id} className="bg-zinc-900/50 rounded-xl border border-white/10 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm text-white">{exec.account_id}</span>
                    <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${
                      exec.connected
                        ? 'text-green-400 bg-green-500/10 ring-green-500/30'
                        : 'text-red-400 bg-red-500/10 ring-red-500/30'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${exec.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                      {exec.connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-2">
                    Last heartbeat: {new Date(exec.last_heartbeat).toLocaleTimeString()}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Copy Configs */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Copy Configurations</h2>
            <button
              onClick={() => { resetForm(); setShowForm(true); }}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors text-sm"
            >
              + Add Config
            </button>
          </div>

          {/* Add/Edit Form */}
          {(showForm || editingConfig) && (
            <div className="bg-zinc-900/50 rounded-xl border border-orange-500/20 p-6 mb-4">
              <h3 className="text-sm font-bold text-white mb-4">
                {editingConfig ? 'Edit Configuration' : 'New Configuration'}
              </h3>
              <div className="grid gap-4 sm:grid-cols-3">
                {!editingConfig && (
                  <>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Source Account</label>
                      <select
                        value={formSource}
                        onChange={(e) => setFormSource(e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                      >
                        <option value="">Select account</option>
                        {accounts.map(a => (
                          <option key={a.account_id} value={a.account_id}>{a.account_id}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">Destination Account</label>
                      <select
                        value={formDest}
                        onChange={(e) => setFormDest(e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                      >
                        <option value="">Select account</option>
                        {accounts.map(a => (
                          <option key={a.account_id} value={a.account_id}>{a.account_id}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Volume Multiplier</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={formMultiplier}
                    onChange={(e) => setFormMultiplier(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button
                  onClick={editingConfig ? handleUpdateConfig : handleCreateConfig}
                  className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-lg transition-colors text-sm"
                >
                  {editingConfig ? 'Save Changes' : 'Create'}
                </button>
                <button
                  onClick={resetForm}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Config Cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {configs.length === 0 ? (
              <div className="col-span-full bg-zinc-900/50 rounded-xl border border-white/10 p-8 text-center text-zinc-500 text-sm">
                No copy configurations yet. Click "Add Config" to create one.
              </div>
            ) : (
              configs.map((config) => (
                <div key={config.id} className={`bg-zinc-900/50 rounded-xl border p-5 ${
                  config.enabled ? 'border-white/10' : 'border-white/5 opacity-60'
                }`}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${config.enabled ? 'bg-green-500' : 'bg-zinc-600'}`} />
                      <span className="text-xs font-medium text-zinc-400">#{config.id}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleToggleEnabled(config)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                          config.enabled
                            ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                            : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
                        }`}
                      >
                        {config.enabled ? 'ON' : 'OFF'}
                      </button>
                      <button
                        onClick={() => startEdit(config)}
                        className="px-2 py-1 rounded text-xs font-medium bg-zinc-700 text-zinc-400 hover:bg-zinc-600 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteConfig(config.id)}
                        className="px-2 py-1 rounded text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                      >
                        Del
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <div className="bg-zinc-800 rounded-lg px-3 py-1.5 text-center">
                      <p className="text-xs text-zinc-500">Source</p>
                      <p className="font-mono text-sm text-white">{config.source_account_id}</p>
                    </div>
                    <svg className="w-4 h-4 text-orange-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                    <div className="bg-zinc-800 rounded-lg px-3 py-1.5 text-center">
                      <p className="text-xs text-zinc-500">Dest</p>
                      <p className="font-mono text-sm text-white">{config.dest_account_id}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-zinc-500">Multiplier</p>
                      <p className="text-sm font-bold text-white">{config.volume_multiplier}x</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-zinc-500">Executor</p>
                      <span className={`text-xs font-medium ${
                        isExecutorConnected(config.dest_account_id) ? 'text-green-400' : 'text-zinc-600'
                      }`}>
                        {isExecutorConnected(config.dest_account_id) ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Recent Signals */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Recent Signals</h2>
          <div className="bg-zinc-900/50 rounded-xl border border-white/10 overflow-hidden">
            {signals.length === 0 ? (
              <div className="p-8 text-center text-zinc-500 text-sm">
                No copy signals yet. Signals will appear when trades are copied.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">ID</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Type</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Symbol</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Direction</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Volume</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Status</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Source</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Dest</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Time</th>
                      <th className="text-left text-xs font-medium text-zinc-500 px-4 py-3">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50">
                    {signals.map((signal) => (
                      <tr key={signal.id} className="hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-3 font-mono text-zinc-400">#{signal.id}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getSignalTypeBadge(signal.signal_type)}`}>
                            {signal.signal_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-white">{signal.symbol || '-'}</td>
                        <td className="px-4 py-3">
                          {signal.direction ? (
                            <span className={signal.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}>
                              {signal.direction}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-zinc-300">{signal.volume || '-'}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getStatusBadge(signal.status)}`}>
                            {signal.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-zinc-400 text-xs">{signal.source_account_id}</td>
                        <td className="px-4 py-3 font-mono text-zinc-400 text-xs">{signal.dest_account_id}</td>
                        <td className="px-4 py-3 text-zinc-500 text-xs">
                          {new Date(signal.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-red-400 text-xs max-w-[200px] truncate">
                          {signal.error_message || ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
