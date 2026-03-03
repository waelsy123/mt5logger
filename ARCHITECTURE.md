# MT5 Trade Logger — Architecture & Configuration Guide

## Overview

MT5 Trade Logger is a real-time trade monitoring and copy trading platform for MetaTrader 5.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  MT5 Terminal │     │  MT5 Terminal │     │  MT5 Terminal │
│  (Source EA)  │     │  (Source EA)  │     │   (Dest Acct) │
│  Account A    │     │  Account B    │     │   Account C   │
└──────┬───────┘     └──────┬───────┘     └──────▲───────┘
       │ webhook            │ webhook            │ trades
       ▼                    ▼                    │
┌─────────────────────────────────────┐   ┌──────┴───────┐
│         Backend (Node.js)           │   │   Executor    │
│  ┌─────────┐  ┌──────────────────┐  │   │  (Docker)     │
│  │ Express  │  │  RabbitMQ Pub/   │  │   │  Wine + MT5   │
│  │ Webhook  │→ │  Consumer        │──│──→│  + Python     │
│  │ REST API │  │  Copy Signal Gen │  │   │  mt5linux     │
│  └────┬─────┘  └────────┬────────┘  │   └──────────────┘
│       │                 │            │
│  ┌────▼─────┐  ┌────────▼────────┐  │
│  │ WebSocket │  │   PostgreSQL    │  │
│  │ /ws       │  │   Database      │  │
│  │ /ws/exec  │  │                 │  │
│  └────┬──────┘  └────────────────┘  │
└───────│─────────────────────────────┘
        │
   ┌────▼─────┐
   │ Frontend  │
   │ (Next.js) │
   │ Dashboard │
   └──────────┘
```

**Components:**
- **EA (v1.04)** — MQL5 Expert Advisor on source MT5 terminals, sends trade events via HTTP webhook
- **Backend** — Node.js/TypeScript service with Express, RabbitMQ, PostgreSQL, dual WebSocket
- **Frontend** — Next.js dashboard for account monitoring and copy trading management
- **Executor** — Docker container (Debian + Wine + MT5 + Python) that executes copied trades on destination accounts

---

## Services & Railway Deployment

| Service | Railway Name | Root Dir | Tech Stack |
|---------|-------------|----------|------------|
| Backend API | `mt5-logger` | `/` | Node.js, Express, PostgreSQL, RabbitMQ |
| Frontend | `mt5-frontend` | `/mt5-frontend` | Next.js, Tailwind |
| Executor | `mt5-executor` | `/executor` | Debian, Wine, MT5, Python |
| Database | `Postgres` | — | Managed PostgreSQL |
| Message Broker | `RabbitMQ` | — | Managed RabbitMQ |

---

## Environment Variables

### Backend (`mt5-logger`)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `API_KEY` | Yes | Bearer token for webhook + executor auth | `a1b2c3d4-...` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/railway` |
| `RABBITMQ_URL` | Yes | AMQP connection string | `amqp://user:pass@rabbitmq.railway.internal:5672` |
| `PORT` | No | HTTP port (default: 3000) | `8080` |

### Frontend (`mt5-frontend`)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NEXT_PUBLIC_MT5_API_URL` | Yes | Backend URL (used client-side) | `https://mt5-logger-production.up.railway.app` |

### Executor (`mt5-executor`)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `MT5_SERVER_URL` | Yes | Backend executor WebSocket endpoint | `wss://mt5-logger-production.up.railway.app/ws/executor` |
| `MT5_API_KEY` | Yes | Same API_KEY as backend | `a1b2c3d4-...` |
| `MT5_LOGIN` | Yes | Destination MT5 account number | `12345678` |
| `MT5_PASSWORD` | Yes | Destination MT5 account password | `MyP@ss` |
| `MT5_SERVER` | Yes | Broker server name | `MetaQuotes-Demo` |
| `MT5_ACCOUNT_ID` | Yes | Account ID for executor routing (usually same as login) | `12345678` |

### EA (MetaTrader 5 Inputs)

| Input | Description | Example |
|-------|-------------|---------|
| `InpWebhookUrl` | Backend webhook endpoint | `https://mt5-logger-production.up.railway.app/webhook` |
| `InpApiKey` | Same API_KEY as backend | `a1b2c3d4-...` |
| `InpMagicNumber` | Filter by magic number (0 = all) | `0` |
| `InpTimerSeconds` | Polling interval for snapshots | `30` |

---

## Data Flow

### 1. Trade Monitoring (EA to Dashboard)

```
EA trade on MT5
  → OnTradeTransaction fires
  → BuildDealPayload() with entry field
  → POST /webhook (Bearer auth)
  → Backend publishes to RabbitMQ (mt5.deal.new)
  → Consumer stores deal in PostgreSQL
  → Consumer broadcasts via /ws to frontend
  → Dashboard updates in real-time
```

### 2. Account Snapshots (EA Timer)

```
Every 30 seconds:
  → EA sends account snapshot (balance, equity, P&L)
  → EA sends open positions array
  → EA sends open orders array
  → Backend stores in PostgreSQL
  → Frontend receives via /ws
```

### 3. Copy Trading Signal Flow

```
Source EA deal (DEAL_ENTRY_IN) arrives
  → Consumer queries copy_configs for source account
  → For each active config:
    → Creates copy_signal (type=open, volume * multiplier)
    → Calls sendToExecutor(signal)
    → Server looks up executor WS by dest_account_id
    → Sends signal to executor
    → Executor executes TRADE_ACTION_DEAL on dest MT5
    → Executor sends signal_result back
    → Server updates signal status to "filled"
    → Server creates position_mapping (source_ticket → dest_ticket)
    → Server broadcasts copy_signal_result to frontend

Source EA deal (DEAL_ENTRY_OUT) arrives
  → Consumer looks up dest_position_ticket via position_mapping
  → Creates copy_signal (type=close)
  → Executor closes dest position with opposite order
  → Server marks position_mapping as closed (is_open=false)

Source EA position_modify (SL/TP change)
  → Consumer looks up dest_position_ticket via position_mapping
  → Creates copy_signal (type=modify)
  → Executor sends TRADE_ACTION_SLTP on dest position
```

### 4. Signal Status Lifecycle

```
pending → sent → filled
                → failed (with error_message)
```

- **pending**: Signal created in database
- **sent**: Dispatched to executor WebSocket
- **filled**: Executor confirmed trade execution
- **failed**: No executor connected, or trade execution error

---

## API Endpoints

### Webhook (EA → Backend)
```
POST /webhook                     Bearer auth required
  event_type: deal | order | account | positions | open_orders | position_modify
```

### Accounts
```
GET  /accounts                    List all accounts with latest snapshot
GET  /accounts/:id                Latest snapshot for one account
GET  /accounts/:id/deals          Recent closed deals (?limit=100)
GET  /accounts/:id/positions      Open positions
GET  /accounts/:id/orders         Recent orders (?limit=100)
GET  /accounts/:id/open-orders    Pending orders
GET  /accounts/:id/snapshots      Account history (?since=<ISO>)
GET  /accounts/:id/daily-pnl      Daily P&L (?days=30)
GET  /accounts/:id/stats          Win rate, total P&L, commissions
POST /accounts/:id/request-refresh Queue data refresh for EA
```

### Copy Trading
```
GET    /copy/configs              List all copy configs
POST   /copy/configs              Create config {source_account_id, dest_account_id, volume_multiplier}
GET    /copy/configs/:id          Get single config
PUT    /copy/configs/:id          Update {volume_multiplier?, enabled?}
DELETE /copy/configs/:id          Delete config
GET    /copy/signals              List signals (?limit=50&config_id=&status=)
GET    /copy/signals/:id          Get single signal
GET    /copy/position-map         Position mappings (?config_id=&is_open=true)
GET    /copy/executor/status      Connected executor status
```

### WebSocket
```
/ws                               Frontend real-time events
/ws/executor?token=KEY&account=ID Executor signal dispatch
```

---

## Database Schema

### Core Tables

**`deals`** — Every filled deal from EA
- `ticket` (PK), `account_id`, `order_ticket`, `position_ticket`
- `symbol`, `type`, `volume`, `price`, `profit`, `commission`, `swap`
- `sl`, `tp`, `magic_number`, `comment`, `entry`, `deal_time`, `raw_data`

**`orders`** — Pending orders from EA
- `ticket` (PK), `account_id`, `symbol`, `type`, `volume`, `price`
- `sl`, `tp`, `order_time`, `raw_data`

**`account_snapshots`** — Balance/equity history
- `id` (PK), `account_id`, `balance`, `equity`, `margin`, `free_margin`
- `daily_pnl`, `unrealized_pnl`, `currency`, `snapshot_time`

**`open_positions`** — Current snapshot of open positions (replaced each tick)
- PK: `(ticket, account_id)`, `symbol`, `type`, `volume`, `price_open`, `price_current`
- `sl`, `tp`, `profit`, `swap`, `position_time`, `magic_number`

**`open_orders`** — Current snapshot of pending orders (replaced each tick)
- PK: `(ticket, account_id)`, `symbol`, `type`, `volume`, `price`
- `sl`, `tp`, `order_time`, `magic_number`, `comment`

### Copy Trading Tables

**`copy_configs`** — Source → Destination mappings
- `id` (PK), `source_account_id`, `dest_account_id`
- `volume_multiplier` (default 1.0), `enabled` (default true)
- UNIQUE constraint: `(source_account_id, dest_account_id)`

**`copy_signals`** — Every generated copy signal
- `id` (PK), `config_id` (FK), `source_account_id`, `dest_account_id`
- `signal_type` (open/close/modify), `symbol`, `direction` (BUY/SELL), `volume`
- `source_position_ticket`, `source_deal_ticket`, `sl`, `tp`
- `status` (pending/sent/filled/failed), `error_message`
- `dest_deal_ticket`, `dest_position_ticket`, `dest_price`, `executed_at`

**`copy_position_map`** — Links source positions to destination positions
- `id` (PK), `config_id` (FK), `source_position_ticket`, `dest_position_ticket`
- `symbol`, `is_open` (default true), `closed_at`

---

## Executor Container Architecture

```
Docker Container (Debian Bookworm + Wine)
├── Xvfb :99              Virtual display for Wine GUI
├── Wine → terminal64.exe  MT5 terminal (auto-login with env vars)
├── Wine → Python 3.10     Windows Python with MetaTrader5 lib
│   └── RPyC server :18812 Bridges MT5 API to Linux
└── Linux Python 3
    └── trade_executor.py   WebSocket client + mt5linux bridge
        └── Connects to /ws/executor?token=KEY&account=ID
```

**Startup sequence** (`start.sh`):
1. Xvfb starts virtual framebuffer on display :99
2. MT5 terminal launches via Wine with `/login`, `/password`, `/server` flags
3. Wait 15s for MT5 initialization
4. RPyC bridge server starts on port 18812 (Windows Python)
5. `trade_executor.py` starts (Linux Python), connects to RPyC + WebSocket

**Trade execution** uses `mt5linux` library which communicates with the MetaTrader5 Windows API through RPyC:
- **Open**: `TRADE_ACTION_DEAL` with volume, SL, TP, magic=999999
- **Close**: Opposite `TRADE_ACTION_DEAL` on dest_position_ticket
- **Modify**: `TRADE_ACTION_SLTP` with new SL/TP values

---

## Configuration Guide: Adding a New Destination Account

### Step 1: Create Copy Config

Via dashboard at `/copy-trading`:
1. Select source account from dropdown
2. Select destination account (or enter manually)
3. Set volume multiplier (e.g., 0.5 = half size, 2.0 = double size)
4. Click Create

Or via API:
```bash
curl -X POST https://mt5-logger-production.up.railway.app/copy/configs \
  -H 'Content-Type: application/json' \
  -d '{
    "source_account_id": 541171640,
    "dest_account_id": 12345678,
    "volume_multiplier": 1.0
  }'
```

### Step 2: Deploy Executor Service

1. In Railway dashboard, create a new service (or use the existing `mt5-executor`)
2. Set **Root Directory** to `executor`
3. Set environment variables:

```
MT5_SERVER_URL=wss://mt5-logger-production.up.railway.app/ws/executor
MT5_API_KEY=<same API_KEY as mt5-logger service>
MT5_LOGIN=12345678
MT5_PASSWORD=YourPassword
MT5_SERVER=YourBroker-Server
MT5_ACCOUNT_ID=12345678
```

4. Deploy — container builds (~10-15 min first time), starts MT5, connects to backend

### Step 3: Verify

1. Check executor status: `GET /copy/executor/status` — should show `connected: true`
2. Dashboard at `/copy-trading` should show executor as "Online"
3. Place a trade on the source account
4. Check signals: `GET /copy/signals` — should show signal with status "filled"
5. Check dest account — should have matching position

### Multiple Destination Accounts

Each destination account requires its own executor service. To add more:
1. Create another Railway service with a different name (e.g., `mt5-executor-2`)
2. Set root directory to `executor`
3. Set env vars with the new destination account's MT5 credentials
4. Create a copy config mapping source → new destination
5. Deploy

The backend supports unlimited executors — each registers via WebSocket keyed by `MT5_ACCOUNT_ID`.

---

## EA Setup on Source MT5 Terminal

1. **Compile**: Open `mt5/TradeLogger.mq5` in MetaEditor, press F7
2. **Allow WebRequest**: Tools → Options → Expert Advisors
   - Check "Allow WebRequest for listed URL"
   - Add: `https://mt5-logger-production.up.railway.app`
3. **Attach EA**: Drag onto any chart
4. **Set Inputs**:
   - `WebhookUrl`: `https://mt5-logger-production.up.railway.app/webhook`
   - `ApiKey`: Your API_KEY
   - `MagicNumber`: 0 (log all) or specific number
   - `TimerSeconds`: 30
5. **Enable**: Click "Allow Algo Trading" in MT5 toolbar

The EA sends:
- **Deal events** with `entry` field (DEAL_ENTRY_IN/OUT) — triggers copy signals
- **Position modify** events when SL/TP changes — triggers SL/TP sync
- **Account/positions/orders snapshots** every 30s — for dashboard monitoring

---

## RabbitMQ Message Flow

**Exchange**: `mt5.events` (topic, durable)
**Queue**: `mt5.trades` (durable, 1h TTL, 10k max messages)
**Routing pattern**: `mt5.#`

| Routing Key | Publisher Method | Consumer Action |
|-------------|-----------------|-----------------|
| `mt5.deal.new` | `publishDealEvent()` | Store deal, broadcast, generate copy signals |
| `mt5.order.new` | `publishOrderEvent()` | Store order, broadcast |
| `mt5.account.snapshot` | `publishAccountEvent()` | Store snapshot, broadcast |
| `mt5.positions.snapshot` | `publishPositionsEvent()` | Replace positions, broadcast |
| `mt5.open_orders.snapshot` | `publishOpenOrdersEvent()` | Replace orders, broadcast |
| `mt5.position.modify` | `publishPositionModifyEvent()` | Broadcast, generate modify signals |

---

## WebSocket Message Types

### Frontend `/ws`

**Server → Client:**
```json
{"type": "connected", "message": "Connected to MT5 Trade Logger WebSocket"}
{"type": "deal", "data": {...}, "timestamp": "ISO8601"}
{"type": "order", "data": {...}, "timestamp": "ISO8601"}
{"type": "account", "data": {...}, "timestamp": "ISO8601"}
{"type": "positions", "data": {...}, "timestamp": "ISO8601"}
{"type": "open_orders", "data": {...}, "timestamp": "ISO8601"}
{"type": "position_modify", "data": {...}, "timestamp": "ISO8601"}
{"type": "copy_signal_result", "data": {...}, "timestamp": "ISO8601"}
```

### Executor `/ws/executor`

**Server → Executor:**
```json
{"type": "connected", "account_id": 12345678}
{"type": "signal", "signal": {"id": 1, "signal_type": "open", "symbol": "EURUSD", ...}}
```

**Executor → Server:**
```json
{"type": "signal_result", "signal_id": 1, "status": "filled", "dest_deal_ticket": 999, ...}
{"type": "heartbeat"}
```

---

## Monitoring & Troubleshooting

### Logs to Watch

| Prefix | Component | What to look for |
|--------|-----------|------------------|
| `[API]` | HTTP server | Webhook receives, command delivery |
| `[Consumer]` | RabbitMQ | Message processing, errors |
| `[CopyTrading]` | Signal gen | Config lookups, signal creation |
| `[Executor]` | Signal dispatch | Send/fail status, result handling |
| `[Executor WS]` | WS connections | Connect/disconnect events |
| `[WebSocket]` | Frontend WS | Client connections, broadcasts |
| `[Database]` | PostgreSQL | Store operations, connection errors |
| `[MT5]` | Executor | MT5 connection status |
| `[Trade]` | Executor | OPEN/CLOSE/MODIFY results |

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Signals stuck in "pending" | No executor connected | Check executor logs, verify MT5_SERVER_URL |
| Signals "failed" immediately | Executor not connected for that account | Verify MT5_ACCOUNT_ID matches dest_account_id in config |
| No signals generated | No active copy_config for source | Create config via dashboard |
| Deals missing entry field | EA version < 1.04 | Recompile and reload EA |
| Position modify not detected | EA version < 1.04 | Recompile and reload EA |
| Executor crashes on start | MT5 login failed | Check MT5_LOGIN, MT5_PASSWORD, MT5_SERVER |
| Close signal "no mapping" | Position was opened before copy config | Only positions opened after config creation are tracked |

---

## Security Notes

- **API_KEY** authenticates both EA webhooks and executor WebSocket connections — keep it secret
- **MT5 credentials** are stored only as Railway environment variables — never in code
- Copy trades use magic number `999999` to distinguish them from manual trades
- All database queries are parameterized (no SQL injection risk)
- CORS is enabled on the backend — restrict in production if needed
