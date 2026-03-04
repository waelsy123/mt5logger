#!/bin/bash
set -e

echo "[Executor] Starting up..."

# Clean stale Xvfb lock files from previous runs
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Start virtual framebuffer
echo "[Executor] Starting Xvfb on display :99..."
Xvfb :99 -screen 0 1024x768x16 &
sleep 2

# Helper: wait for wineserver to finish
wait_wine() {
    while pgrep -x wineserver > /dev/null 2>&1; do sleep 1; done
}

# ── Wine + MT5 runtime setup ──────────────────────────────────────────

# Initialize Wine prefix if not already done
if [ ! -f "$WINEPREFIX/system.reg" ]; then
    echo "[Executor] Initializing Wine prefix..."
    wineboot --init 2>&1
    wait_wine
    echo "[Executor] Wine prefix initialized."
fi

# Install MT5 via Wine installer (works at runtime, not at build time)
MT5_PATH=$(find "$WINEPREFIX" -name "terminal64.exe" -type f 2>/dev/null | head -1)
if [ -z "$MT5_PATH" ]; then
    echo "[Executor] Installing MetaTrader 5 via Wine installer..."
    wget -q -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
    set +e
    timeout 300 wine /tmp/mt5setup.exe /auto 2>&1
    echo "[Executor] MT5 installer finished (exit: $?)"
    set -e
    wait_wine
    rm -f /tmp/mt5setup.exe

    MT5_PATH=$(find "$WINEPREFIX" -name "terminal64.exe" -type f 2>/dev/null | head -1)
    if [ -z "$MT5_PATH" ]; then
        echo "[Executor] ERROR: terminal64.exe not found after install!"
        find "$WINEPREFIX/drive_c" -maxdepth 4 -type d 2>/dev/null | head -30
        exit 1
    fi
    echo "[Executor] MT5 installed at: $MT5_PATH"
fi

echo "[Executor] MT5 terminal: $MT5_PATH"

# Install Wine Python via embedded zip (MSI installer doesn't work in Wine 8)
PYDIR="$WINEPREFIX/drive_c/Python39"
WINE_PYTHON="$PYDIR/python.exe"

if [ ! -f "$WINE_PYTHON" ]; then
    echo "[Executor] Installing Python 3.9 (embedded zip)..."
    wget -q -O /tmp/python-embed.zip "https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip"
    mkdir -p "$PYDIR"
    unzip -o /tmp/python-embed.zip -d "$PYDIR" > /dev/null 2>&1
    rm -f /tmp/python-embed.zip

    # Enable pip: uncomment 'import site' in ._pth file and add site-packages
    PTH_FILE=$(ls "$PYDIR"/python*._pth 2>/dev/null | head -1)
    if [ -n "$PTH_FILE" ]; then
        sed -i 's/^#import site/import site/' "$PTH_FILE"
        echo "Lib/site-packages" >> "$PTH_FILE"
    fi
    mkdir -p "$PYDIR/Lib/site-packages"

    # Install pip via get-pip.py
    echo "[Executor] Installing pip..."
    wget -q -O /tmp/get-pip.py "https://bootstrap.pypa.io/get-pip.py"
    set +e
    wine "$WINE_PYTHON" /tmp/get-pip.py --no-warn-script-location 2>&1
    PIP_EXIT=$?
    set -e
    wait_wine
    rm -f /tmp/get-pip.py
    echo "[Executor] get-pip.py exit code: $PIP_EXIT"

    # Install MetaTrader5 and rpyc
    echo "[Executor] Installing MetaTrader5 + rpyc..."
    set +e
    wine "$WINE_PYTHON" -m pip install --no-cache-dir MetaTrader5 "rpyc==5.3.1" --no-warn-script-location 2>&1
    PIP2_EXIT=$?
    set -e
    wait_wine
    echo "[Executor] pip install exit code: $PIP2_EXIT"
fi

echo "[Executor] Wine Python: $WINE_PYTHON"

# ── Start services ────────────────────────────────────────────────────

echo "[Executor] Starting MT5 terminal..."
wine "$MT5_PATH" \
    /login:${MT5_LOGIN} \
    /password:${MT5_PASSWORD} \
    /server:${MT5_SERVER} \
    /portable &

echo "[Executor] Waiting for MT5 to initialize (15s)..."
sleep 15

echo "[Executor] Starting RPyC bridge server on port 18812..."
wine "$WINE_PYTHON" -c "
from rpyc.utils.server import ThreadedServer
from rpyc.utils.classic import SlaveService

t = ThreadedServer(SlaveService, hostname='localhost', port=18812,
    protocol_config={'allow_all_attrs': True, 'allow_public_attrs': True})
print('[RPyC] Classic server started on port 18812')
t.start()
" &

echo "[Executor] Waiting for RPyC server (5s)..."
sleep 5

echo "[Executor] Starting trade executor..."
exec python3 /app/trade_executor.py
