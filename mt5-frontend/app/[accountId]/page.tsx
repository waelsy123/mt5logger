'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface AccountSnapshot {
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

interface Deal {
  ticket: number;
  account_id: string;
  order_ticket: number;
  position_ticket: number;
  symbol: string;
  type: string;
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  sl: number;
  tp: number;
  magic_number: number;
  comment: string;
  deal_time: string;
}

interface Order {
  ticket: number;
  account_id: string;
  symbol: string;
  type: string;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  order_time: string;
}

interface Position {
  ticket: number;
  account_id: string;
  symbol: string;
  type: string;
  volume: number;
  price_open: number;
  price_current: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  position_time: string;
  magic_number: number;
}

interface DailyPnl {
  date: string;
  daily_pnl: number;
  balance: number;
  equity: number;
}

interface Stats {
  total_trades: number;
  winning_trades: number;
  win_rate: number;
  total_pnl: number;
  total_commission: number;
  total_swap: number;
}

interface WsEvent {
  id: string;
  type: 'deal' | 'order' | 'account' | 'positions';
  data: Record<string, unknown>;
  timestamp: number;
}

type Tab = 'overview' | 'positions' | 'trades' | 'orders' | 'events';

export default function AccountDetailPage() {
  const params = useParams();
  const router = useRouter();
  const accountId = params.accountId as string;

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [snapshots, setSnapshots] = useState<AccountSnapshot[]>([]);
  const [dailyPnl, setDailyPnl] = useState<DailyPnl[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_MT5_API_URL || 'http://localhost:3001';

  const fetchData = async () => {
    try {
      const [accRes, posRes, dealsRes, ordersRes, snapRes, pnlRes, statsRes] = await Promise.allSettled([
        fetch(`${apiUrl}/accounts/${accountId}`),
        fetch(`${apiUrl}/accounts/${accountId}/positions`),
        fetch(`${apiUrl}/accounts/${accountId}/deals?limit=100`),
        fetch(`${apiUrl}/accounts/${accountId}/orders?limit=100`),
        fetch(`${apiUrl}/accounts/${accountId}/snapshots?since=${new Date(Date.now() - 7 * 86400000).toISOString()}`),
        fetch(`${apiUrl}/accounts/${accountId}/daily-pnl?days=30`),
        fetch(`${apiUrl}/accounts/${accountId}/stats`),
      ]);

      const parseJson = async (r: PromiseSettledResult<Response>): Promise<any | null> => {
        if (r.status === 'fulfilled' && r.value.ok) {
          return r.value.json();
        }
        return null;
      };

      const accData = await parseJson(accRes);
      if (accData?.account) setAccount(accData.account);

      const posData = await parseJson(posRes);
      if (posData?.positions) setPositions(posData.positions);

      const dealsData = await parseJson(dealsRes);
      if (dealsData?.deals) setDeals(dealsData.deals);

      const ordersData = await parseJson(ordersRes);
      if (ordersData?.orders) setOrders(ordersData.orders);

      const snapData = await parseJson(snapRes);
      if (snapData?.snapshots) setSnapshots(snapData.snapshots);

      const pnlData = await parseJson(pnlRes);
      if (pnlData?.history) setDailyPnl(pnlData.history);

      const statsData = await parseJson(statsRes);
      if (statsData?.stats) setStats(statsData.stats);

      setError(null);
    } catch (err) {
      console.error('Failed to fetch account data:', err);
      setError('Failed to load account data');
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = () => {
    const wsUrl = apiUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const relatedAccountId = msg.data?.account_id;
        if (relatedAccountId && String(relatedAccountId) !== String(accountId)) return;

        const newEvent: WsEvent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: msg.type,
          data: msg.data,
          timestamp: Date.now(),
        };
        setEvents(prev => [newEvent, ...prev].slice(0, 50));

        if (msg.type === 'account' && msg.data) {
          setAccount(prev => prev ? { ...prev, ...msg.data } : msg.data);
        }
        if (msg.type === 'positions' && msg.data?.positions) {
          setPositions(msg.data.positions as Position[]);
        }
        if (msg.type === 'deal' && msg.data) {
          setDeals(prev => [msg.data as Deal, ...prev].slice(0, 100));
        }
        if (msg.type === 'order' && msg.data) {
          setOrders(prev => [msg.data as Order, ...prev].slice(0, 100));
        }
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      reconnectRef.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {};
  };

  useEffect(() => {
    fetchData();
    connectWebSocket();

    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [accountId]);

  const filteredDeals = useMemo(() => {
    if (!symbolFilter) return deals;
    return deals.filter(d => d.symbol.toLowerCase().includes(symbolFilter.toLowerCase()));
  }, [deals, symbolFilter]);

  const filteredEvents = useMemo(() => {
    if (eventTypeFilter === 'all') return events;
    return events.filter(e => e.type === eventTypeFilter);
  }, [events, eventTypeFilter]);

  const formatCurrency = (val: number | string, currency?: string) => {
    const n = Number(val) || 0;
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ' ' + currency : '');
  };

  const formatPnl = (val: number | string) => {
    const n = Number(val) || 0;
    const sign = n >= 0 ? '+' : '';
    return sign + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatTime = (ts: string) => {
    if (!ts) return '-';
    // Handle EA format "YYYY.MM.DD HH:MM:SS"
    const normalized = ts.replace(/\./g, '-').replace(' ', 'T');
    const date = new Date(normalized);
    if (isNaN(date.getTime())) return ts;
    return date.toLocaleString();
  };

  const getTypeBadge = (type: string) => {
    const isBuy = type.toUpperCase().includes('BUY');
    return isBuy
      ? 'text-blue-400 bg-blue-500/10 ring-blue-500/30'
      : 'text-red-400 bg-red-500/10 ring-red-500/30';
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'positions', label: 'Positions' },
    { key: 'trades', label: 'Trades' },
    { key: 'orders', label: 'Orders' },
    { key: 'events', label: 'Events' },
  ];

  // --- Equity Curve SVG ---
  const renderEquityCurve = () => {
    if (snapshots.length < 2) {
      return (
        <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
          Not enough data for equity curve
        </div>
      );
    }

    const sorted = [...snapshots].sort((a, b) => new Date(a.snapshot_time).getTime() - new Date(b.snapshot_time).getTime());
    const equities = sorted.map(s => s.equity);
    const times = sorted.map(s => new Date(s.snapshot_time).getTime());

    const width = 800;
    const height = 250;
    const padding = { top: 20, right: 20, bottom: 40, left: 70 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const minEq = Math.min(...equities);
    const maxEq = Math.max(...equities);
    const eqRange = maxEq - minEq || 1;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeRange = maxTime - minTime || 1;

    const points = sorted.map((s, i) => {
      const x = padding.left + ((times[i] - minTime) / timeRange) * chartW;
      const y = padding.top + chartH - ((equities[i] - minEq) / eqRange) * chartH;
      return { x, y };
    });

    const pathD = points.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`)).join(' ');
    const areaD = pathD + ` L${points[points.length - 1].x},${padding.top + chartH} L${points[0].x},${padding.top + chartH} Z`;

    const yTicks = 5;
    const xTicks = Math.min(6, sorted.length);

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
        <defs>
          <linearGradient id="equityGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(59, 130, 246)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(59, 130, 246)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y-axis grid lines and labels */}
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const val = minEq + (eqRange / yTicks) * i;
          const y = padding.top + chartH - (chartH / yTicks) * i;
          return (
            <g key={`y-${i}`}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="10">
                {val.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {Array.from({ length: xTicks }).map((_, i) => {
          const idx = Math.floor((sorted.length - 1) * (i / (xTicks - 1)));
          const x = points[idx].x;
          const date = new Date(sorted[idx].snapshot_time);
          const label = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
          return (
            <text key={`x-${i}`} x={x} y={height - 8} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="10">
              {label}
            </text>
          );
        })}

        {/* Area fill */}
        <path d={areaD} fill="url(#equityGradient)" />

        {/* Line */}
        <path d={pathD} fill="none" stroke="rgb(59, 130, 246)" strokeWidth="2" />

        {/* Dots on first and last */}
        <circle cx={points[0].x} cy={points[0].y} r="3" fill="rgb(59, 130, 246)" />
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="3" fill="rgb(59, 130, 246)" />
      </svg>
    );
  };

  // --- Daily PnL Bar Chart ---
  const renderDailyPnlChart = () => {
    if (dailyPnl.length === 0) {
      return (
        <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
          No daily PnL data available
        </div>
      );
    }

    const width = 800;
    const height = 200;
    const padding = { top: 20, right: 20, bottom: 40, left: 70 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const maxAbs = Math.max(...dailyPnl.map(d => Math.abs(d.daily_pnl)), 1);
    const barWidth = Math.max(2, chartW / dailyPnl.length - 2);
    const zeroY = padding.top + chartH / 2;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
        {/* Zero line */}
        <line x1={padding.left} y1={zeroY} x2={width - padding.right} y2={zeroY} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

        {dailyPnl.map((d, i) => {
          const x = padding.left + (i / dailyPnl.length) * chartW + 1;
          const barH = (Math.abs(d.daily_pnl) / maxAbs) * (chartH / 2);
          const y = d.daily_pnl >= 0 ? zeroY - barH : zeroY;
          const fill = d.daily_pnl >= 0 ? 'rgb(74, 222, 128)' : 'rgb(248, 113, 113)';

          return (
            <g key={d.date}>
              <rect x={x} y={y} width={barWidth} height={barH} fill={fill} rx="1" opacity="0.8" />
              {i % Math.ceil(dailyPnl.length / 8) === 0 && (
                <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="9">
                  {new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </text>
              )}
            </g>
          );
        })}

        {/* Y labels */}
        <text x={padding.left - 8} y={padding.top + 4} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="10">
          +{maxAbs.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </text>
        <text x={padding.left - 8} y={zeroY + 4} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="10">
          0
        </text>
        <text x={padding.left - 8} y={padding.top + chartH + 4} textAnchor="end" fill="rgba(255,255,255,0.4)" fontSize="10">
          -{maxAbs.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </text>
      </svg>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white flex items-center justify-center">
        <div className="text-zinc-500 flex items-center gap-2">
          <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Loading account {accountId}...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-red-500/20">
            <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-xl font-bold mb-2 text-white">{error}</h3>
          <p className="text-zinc-400 text-sm mb-4">Could not load data for account {accountId}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => router.push('/')}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors text-sm"
            >
              Back to Dashboard
            </button>
            <button
              onClick={() => { setError(null); setLoading(true); fetchData(); }}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg transition-colors text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-zinc-950 to-black text-white">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center gap-4 mb-4">
            <button
              onClick={() => router.push('/')}
              className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Dashboard
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-blue-500 to-cyan-500 bg-clip-text text-transparent">
                Account {accountId}
              </h1>
              {account && (
                <div className="flex items-center gap-4 mt-2 text-sm text-zinc-400">
                  <span>Balance: <span className="text-white font-medium">{formatCurrency(account.balance, account.currency)}</span></span>
                  <span>Equity: <span className="text-white font-medium">{formatCurrency(account.equity, account.currency)}</span></span>
                </div>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-6">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeTab === tab.key
                    ? 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/30'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Overview Tab */}
        {activeTab === 'overview' && account && (
          <div className="space-y-8">
            {/* Stats Grid */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Balance</p>
                <p className="text-2xl font-bold text-white">{formatCurrency(account.balance, account.currency)}</p>
              </div>
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Equity</p>
                <p className="text-2xl font-bold text-white">{formatCurrency(account.equity, account.currency)}</p>
              </div>
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Margin</p>
                <p className="text-lg font-bold text-white">{formatCurrency(account.margin, account.currency)}</p>
                <p className="text-xs text-zinc-500 mt-1">Free: {formatCurrency(account.free_margin, account.currency)}</p>
              </div>
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Daily PnL</p>
                <p className={`text-2xl font-bold ${Number(account.daily_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatPnl(account.daily_pnl)}
                </p>
              </div>
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                <p className="text-xs text-zinc-500 mb-1">Unrealized PnL</p>
                <p className={`text-2xl font-bold ${Number(account.unrealized_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatPnl(account.unrealized_pnl)}
                </p>
              </div>
              {stats && (
                <>
                  <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                    <p className="text-xs text-zinc-500 mb-1">Win Rate</p>
                    <p className="text-2xl font-bold text-white">{Number(stats.win_rate).toFixed(1)}%</p>
                    <p className="text-xs text-zinc-500 mt-1">{stats.winning_trades}W / {Number(stats.total_trades) - Number(stats.winning_trades)}L</p>
                  </div>
                  <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                    <p className="text-xs text-zinc-500 mb-1">Total Trades</p>
                    <p className="text-2xl font-bold text-white">{stats.total_trades.toLocaleString()}</p>
                  </div>
                  <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-5 border border-white/10">
                    <p className="text-xs text-zinc-500 mb-1">Total PnL</p>
                    <p className={`text-2xl font-bold ${Number(stats.total_pnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {formatPnl(stats.total_pnl)}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">
                      Comm: {formatCurrency(stats.total_commission)} | Swap: {formatCurrency(stats.total_swap)}
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* Equity Curve */}
            <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-6 border border-white/10">
              <h3 className="text-lg font-bold text-white mb-4">Equity Curve</h3>
              {renderEquityCurve()}
            </div>

            {/* Daily PnL Chart */}
            <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl p-6 border border-white/10">
              <h3 className="text-lg font-bold text-white mb-4">Daily PnL (Last 30 Days)</h3>
              {renderDailyPnlChart()}
            </div>
          </div>
        )}

        {/* Positions Tab */}
        {activeTab === 'positions' && (
          <div>
            {positions.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-zinc-700">
                  <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold mb-1 text-white">No open positions</h3>
                <p className="text-zinc-400 text-sm">Open positions will appear here in real-time</p>
              </div>
            ) : (
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl border border-white/10 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Symbol</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Volume</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Entry Price</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Current Price</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">SL</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">TP</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Profit</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Swap</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Open Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {positions.map((pos) => (
                        <tr key={pos.ticket} className="hover:bg-white/5 transition-colors">
                          <td className="px-4 py-3 text-white font-medium">{pos.symbol}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getTypeBadge(pos.type)}`}>
                              {pos.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-300">{Number(pos.volume)}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(pos.price_open).toFixed(5)}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(pos.price_current).toFixed(5)}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(pos.sl) > 0 ? Number(pos.sl).toFixed(5) : '-'}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(pos.tp) > 0 ? Number(pos.tp).toFixed(5) : '-'}</td>
                          <td className={`px-4 py-3 text-right font-bold ${Number(pos.profit) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnl(pos.profit)}
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-400">{Number(pos.swap).toFixed(2)}</td>
                          <td className="px-4 py-3 text-zinc-400 text-xs">{formatTime(pos.position_time)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Trades Tab */}
        {activeTab === 'trades' && (
          <div>
            <div className="mb-4">
              <input
                type="text"
                placeholder="Filter by symbol..."
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                className="px-4 py-2 bg-zinc-900/50 border border-white/10 rounded-lg text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/50 w-64"
              />
            </div>

            {filteredDeals.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-zinc-700">
                  <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold mb-1 text-white">No trades found</h3>
                <p className="text-zinc-400 text-sm">{symbolFilter ? 'Try a different filter' : 'Trades will appear here as they are executed'}</p>
              </div>
            ) : (
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl border border-white/10 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Ticket</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Time</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Symbol</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Volume</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Price</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">SL</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">TP</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Profit</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Commission</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Swap</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Comment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {filteredDeals.map((deal) => (
                        <tr key={deal.ticket} className="hover:bg-white/5 transition-colors">
                          <td className="px-4 py-3 text-zinc-400 font-mono text-xs">{deal.ticket}</td>
                          <td className="px-4 py-3 text-zinc-400 text-xs">{formatTime(deal.deal_time)}</td>
                          <td className="px-4 py-3 text-white font-medium">{deal.symbol}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getTypeBadge(deal.type)}`}>
                              {deal.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-300">{deal.volume}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(deal.price).toFixed(5)}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(deal.sl) > 0 ? Number(deal.sl).toFixed(5) : '-'}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(deal.tp) > 0 ? Number(deal.tp).toFixed(5) : '-'}</td>
                          <td className={`px-4 py-3 text-right font-bold ${Number(deal.profit) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnl(deal.profit)}
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-400">{Number(deal.commission).toFixed(2)}</td>
                          <td className="px-4 py-3 text-right text-zinc-400">{Number(deal.swap).toFixed(2)}</td>
                          <td className="px-4 py-3 text-zinc-500 text-xs max-w-[200px] truncate">{deal.comment || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Orders Tab */}
        {activeTab === 'orders' && (
          <div>
            {orders.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-zinc-700">
                  <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold mb-1 text-white">No open orders</h3>
                <p className="text-zinc-400 text-sm">Orders will appear here when placed</p>
              </div>
            ) : (
              <div className="bg-zinc-900/50 backdrop-blur-sm rounded-2xl border border-white/10 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Ticket</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Time</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Symbol</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Volume</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Price</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">SL</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-zinc-500 uppercase">TP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {orders.map((order) => (
                        <tr key={order.ticket} className="hover:bg-white/5 transition-colors">
                          <td className="px-4 py-3 text-zinc-400 font-mono text-xs">{order.ticket}</td>
                          <td className="px-4 py-3 text-zinc-400 text-xs">{formatTime(order.order_time)}</td>
                          <td className="px-4 py-3 text-white font-medium">{order.symbol}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${getTypeBadge(order.type)}`}>
                              {order.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-300">{order.volume}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(order.price).toFixed(5)}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(order.sl) > 0 ? Number(order.sl).toFixed(5) : '-'}</td>
                          <td className="px-4 py-3 text-right text-zinc-300 font-mono">{Number(order.tp) > 0 ? Number(order.tp).toFixed(5) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {(['all', 'deal', 'order', 'account', 'positions'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setEventTypeFilter(type)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    eventTypeFilter === type
                      ? 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/30'
                      : 'text-zinc-400 bg-zinc-800/50 hover:text-white'
                  }`}
                >
                  {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1) + 's'}
                </button>
              ))}
            </div>

            {filteredEvents.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-4 ring-1 ring-zinc-700">
                  <svg className="w-8 h-8 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 className="text-lg font-bold mb-1 text-white">No events yet</h3>
                <p className="text-zinc-400 text-sm">WebSocket events for this account will appear here in real-time</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredEvents.map((event) => (
                  <div
                    key={event.id}
                    className="bg-zinc-900/50 backdrop-blur-sm rounded-xl p-4 border border-white/10 hover:border-white/20 transition-all animate-slideIn"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`px-2 py-0.5 rounded-md text-xs font-medium ring-1 ${
                        event.type === 'deal' ? 'text-green-400 bg-green-500/10 ring-green-500/30'
                        : event.type === 'order' ? 'text-blue-400 bg-blue-500/10 ring-blue-500/30'
                        : event.type === 'positions' ? 'text-cyan-400 bg-cyan-500/10 ring-cyan-500/30'
                        : 'text-purple-400 bg-purple-500/10 ring-purple-500/30'
                      }`}>
                        {event.type}
                      </span>
                      {event.data?.symbol ? (
                        <span className="text-sm text-white font-medium">{String(event.data.symbol)}</span>
                      ) : null}
                      <span className="text-xs text-zinc-500 ml-auto">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-400 font-mono bg-zinc-800/50 rounded-lg p-2 overflow-x-auto">
                      {JSON.stringify(event.data, null, 2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
