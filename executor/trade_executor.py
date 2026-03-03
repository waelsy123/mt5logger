#!/usr/bin/env python3
"""
Trade Executor — runs on Linux, connects to MT5 via mt5linux RPyC bridge,
receives copy signals from the server via WebSocket.
"""

import json
import os
import sys
import time
import threading
import websocket
from mt5linux import MetaTrader5

# Configuration from environment
SERVER_URL = os.environ.get("MT5_SERVER_URL", "ws://localhost:3001/ws/executor")
API_KEY = os.environ.get("MT5_API_KEY", "")
MT5_LOGIN = int(os.environ.get("MT5_LOGIN", "0"))
MT5_PASSWORD = os.environ.get("MT5_PASSWORD", "")
MT5_SERVER = os.environ.get("MT5_SERVER", "")
ACCOUNT_ID = os.environ.get("MT5_ACCOUNT_ID", str(MT5_LOGIN))

COPY_MAGIC = 999999
RPYC_HOST = "localhost"
RPYC_PORT = 18812

# Initialize MT5 via RPyC bridge
mt5 = MetaTrader5(host=RPYC_HOST, port=RPYC_PORT)


def connect_mt5():
    """Connect to MT5 terminal via RPyC bridge."""
    print("[MT5] Connecting via RPyC bridge...")
    if not mt5.initialize():
        print(f"[MT5] initialize() failed: {mt5.last_error()}")
        return False

    account_info = mt5.account_info()
    if account_info is None:
        print(f"[MT5] account_info() failed: {mt5.last_error()}")
        return False

    print(f"[MT5] Connected: login={account_info.login}, "
          f"server={account_info.server}, "
          f"balance={account_info.balance}")
    return True


def execute_open(signal):
    """Execute an open (new position) signal."""
    symbol = signal.get("symbol")
    direction = signal.get("direction", "BUY")
    volume = float(signal.get("volume", 0.01))
    sl = float(signal.get("sl", 0))
    tp = float(signal.get("tp", 0))
    signal_id = signal.get("id")

    # Ensure symbol is available
    if not mt5.symbol_select(symbol, True):
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Symbol {symbol} not available",
        }

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"No tick data for {symbol}",
        }

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": sl if sl > 0 else 0.0,
        "tp": tp if tp > 0 else 0.0,
        "magic": COPY_MAGIC,
        "comment": f"copy#{signal_id}",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"order_send returned None: {mt5.last_error()}",
        }

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Order failed: {result.retcode} - {result.comment}",
        }

    print(f"[Trade] OPEN {direction} {volume} {symbol} @ {result.price} "
          f"(deal={result.deal}, order={result.order})")

    return {
        "signal_id": signal_id,
        "status": "filled",
        "dest_deal_ticket": result.deal,
        "dest_position_ticket": result.order,
        "dest_price": result.price,
    }


def execute_close(signal):
    """Execute a close signal by opening an opposite position."""
    symbol = signal.get("symbol")
    dest_position_ticket = signal.get("dest_position_ticket")
    signal_id = signal.get("id")

    if not dest_position_ticket:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": "No dest_position_ticket provided",
        }

    # Find the position to close
    position = None
    positions = mt5.positions_get(ticket=int(dest_position_ticket))
    if positions and len(positions) > 0:
        position = positions[0]

    if position is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Position {dest_position_ticket} not found",
        }

    # Opposite direction to close
    close_type = mt5.ORDER_TYPE_SELL if position.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(symbol or position.symbol)
    if tick is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"No tick data for {position.symbol}",
        }

    price = tick.bid if position.type == mt5.ORDER_TYPE_BUY else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position.symbol,
        "volume": position.volume,
        "type": close_type,
        "position": int(dest_position_ticket),
        "price": price,
        "magic": COPY_MAGIC,
        "comment": f"copy#{signal_id}",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"order_send returned None: {mt5.last_error()}",
        }

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Close failed: {result.retcode} - {result.comment}",
        }

    print(f"[Trade] CLOSE position {dest_position_ticket} @ {result.price}")

    return {
        "signal_id": signal_id,
        "status": "filled",
        "dest_deal_ticket": result.deal,
        "dest_price": result.price,
    }


def execute_modify(signal):
    """Execute a modify signal (SL/TP change)."""
    dest_position_ticket = signal.get("dest_position_ticket")
    sl = float(signal.get("sl", 0))
    tp = float(signal.get("tp", 0))
    signal_id = signal.get("id")

    if not dest_position_ticket:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": "No dest_position_ticket provided",
        }

    # Find the position
    positions = mt5.positions_get(ticket=int(dest_position_ticket))
    if not positions or len(positions) == 0:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Position {dest_position_ticket} not found",
        }

    position = positions[0]

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": position.symbol,
        "position": int(dest_position_ticket),
        "sl": sl,
        "tp": tp,
    }

    result = mt5.order_send(request)
    if result is None:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"order_send returned None: {mt5.last_error()}",
        }

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": f"Modify failed: {result.retcode} - {result.comment}",
        }

    print(f"[Trade] MODIFY position {dest_position_ticket}: SL={sl}, TP={tp}")

    return {
        "signal_id": signal_id,
        "status": "filled",
    }


def handle_signal(ws, signal):
    """Route signal to appropriate handler and send result back."""
    signal_type = signal.get("signal_type")
    signal_id = signal.get("id")
    print(f"[Signal] Received #{signal_id}: {signal_type} {signal.get('symbol', '')} "
          f"{signal.get('direction', '')}")

    try:
        if signal_type == "open":
            result = execute_open(signal)
        elif signal_type == "close":
            result = execute_close(signal)
        elif signal_type == "modify":
            result = execute_modify(signal)
        else:
            result = {
                "signal_id": signal_id,
                "status": "failed",
                "error_message": f"Unknown signal_type: {signal_type}",
            }
    except Exception as e:
        result = {
            "signal_id": signal_id,
            "status": "failed",
            "error_message": str(e),
        }

    result["type"] = "signal_result"
    ws.send(json.dumps(result))
    print(f"[Signal] #{signal_id} result: {result.get('status')}")


def send_heartbeat(ws):
    """Send heartbeat every 30 seconds."""
    while True:
        try:
            time.sleep(30)
            ws.send(json.dumps({"type": "heartbeat"}))
        except Exception:
            break


def on_message(ws, message):
    try:
        msg = json.loads(message)
        if msg.get("type") == "signal":
            signal = msg.get("signal", {})
            handle_signal(ws, signal)
        elif msg.get("type") == "connected":
            print(f"[WS] Server confirmed connection for account {msg.get('account_id')}")
    except Exception as e:
        print(f"[WS] Error processing message: {e}")


def on_error(ws, error):
    print(f"[WS] Error: {error}")


def on_close(ws, close_status_code, close_msg):
    print(f"[WS] Connection closed: {close_status_code} - {close_msg}")


def on_open(ws):
    print("[WS] Connected to server")
    # Start heartbeat thread
    t = threading.Thread(target=send_heartbeat, args=(ws,), daemon=True)
    t.start()


def main():
    print("=" * 50)
    print("  MT5 Copy Trading Executor")
    print("=" * 50)
    print(f"  Server:  {SERVER_URL}")
    print(f"  Account: {ACCOUNT_ID}")
    print(f"  Login:   {MT5_LOGIN}")
    print()

    # Connect to MT5
    retries = 0
    while retries < 10:
        if connect_mt5():
            break
        retries += 1
        print(f"[MT5] Retry {retries}/10 in 5s...")
        time.sleep(5)
    else:
        print("[MT5] Failed to connect after 10 retries")
        sys.exit(1)

    # WebSocket connection loop with auto-reconnect
    ws_url = f"{SERVER_URL}?token={API_KEY}&account={ACCOUNT_ID}"
    while True:
        try:
            print(f"[WS] Connecting to {SERVER_URL}...")
            ws = websocket.WebSocketApp(
                ws_url,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            print(f"[WS] Connection error: {e}")

        print("[WS] Reconnecting in 5s...")
        time.sleep(5)


if __name__ == "__main__":
    main()
