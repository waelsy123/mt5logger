#!/bin/bash
set -e

echo "[Executor] Starting up..."

# Start virtual framebuffer
echo "[Executor] Starting Xvfb on display :99..."
Xvfb :99 -screen 0 1024x768x16 &
sleep 2

# Start MT5 terminal via Wine
echo "[Executor] Starting MT5 terminal..."
MT5_PATH=$(find /root/.wine -name "terminal64.exe" -type f 2>/dev/null | head -1)
if [ -z "$MT5_PATH" ]; then
    echo "[Executor] ERROR: terminal64.exe not found!"
    exit 1
fi

wine "$MT5_PATH" \
    /login:${MT5_LOGIN} \
    /password:${MT5_PASSWORD} \
    /server:${MT5_SERVER} \
    /portable &

echo "[Executor] Waiting for MT5 to initialize (15s)..."
sleep 15

# Start RPyC server via Wine Python (bridges MetaTrader5 lib to Linux)
echo "[Executor] Starting RPyC bridge server on port 18812..."
wine python -c "
import rpyc
from rpyc.utils.server import ThreadedServer
import MetaTrader5 as mt5

class MT5Service(rpyc.Service):
    def on_connect(self, conn):
        conn._config['allow_public_attrs'] = True
        conn._config['allow_pickle'] = True

t = ThreadedServer(MT5Service, port=18812, protocol_config={
    'allow_all_attrs': True,
    'allow_pickle': True,
    'sync_request_timeout': 30,
})
print('[RPyC] Server started on port 18812')
t.start()
" &

echo "[Executor] Waiting for RPyC server (5s)..."
sleep 5

# Start the trade executor (Linux Python, connects via mt5linux RPyC bridge)
echo "[Executor] Starting trade executor..."
exec python3 /app/trade_executor.py
