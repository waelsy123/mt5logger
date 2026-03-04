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

# Report Wine version
echo "[Executor] Wine version: $(wine --version 2>&1)"

# Initialize Wine prefix if not already done
if [ ! -f "$WINEPREFIX/system.reg" ]; then
    echo "[Executor] Initializing Wine prefix..."
    wineboot --init 2>&1
    wait_wine
    echo "[Executor] Wine prefix initialized."

    # Set Windows version to Windows 11 (per official MT5 Linux script)
    echo "[Executor] Setting Wine to Windows 11 mode..."
    winecfg -v=win11 2>&1
    wait_wine
fi

# Install WebView2 Runtime (required by modern MT5 builds)
if [ ! -d "$WINEPREFIX/drive_c/Program Files/Microsoft/EdgeWebView" ]; then
    echo "[Executor] Installing WebView2 Runtime..."
    wget -q -O /tmp/webview2.exe "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/f2910a1e-e5a6-4f17-b52d-7faf525d17f8/MicrosoftEdgeWebview2Setup.exe"
    set +e
    wine /tmp/webview2.exe /silent /install 2>&1
    echo "[Executor] WebView2 installer exit: $?"
    set -e
    wait_wine
    rm -f /tmp/webview2.exe
fi

# Install MT5 via Wine installer (works at runtime, not at build time)
MT5_PATH=$(find "$WINEPREFIX" -name "terminal64.exe" -type f 2>/dev/null | head -1)
if [ -z "$MT5_PATH" ]; then
    echo "[Executor] Installing MetaTrader 5 (FivePercentOnline broker build)..."
    wget -q -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/five.percent.online.ltd/mt5/mt5setup.exe"
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

# Install Wine Python via embedded zip (MSI installer doesn't work reliably in Wine)
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

# ── Configure broker server ───────────────────────────────────────────

MT5_DIR=$(dirname "$MT5_PATH")

# Write server config so MT5 knows how to connect to the broker
echo "[Executor] Configuring MT5 for server: ${MT5_SERVER}, login: ${MT5_LOGIN}"
mkdir -p "$MT5_DIR/Config"
python3 -c "
import os
server = os.environ.get('MT5_SERVER', '')
login = os.environ.get('MT5_LOGIN', '0')
password = os.environ.get('MT5_PASSWORD', '')
common_path = '$MT5_DIR/Config/common.ini'
content = '[Common]\n'
content += 'Login=' + login + '\n'
content += 'Server=' + server + '\n'
content += 'KeepPrivate=1\n'
content += 'NewsEnable=0\n'
content += 'CertInstall=0\n'
with open(common_path, 'wb') as f:
    f.write(b'\xff\xfe')  # UTF-16LE BOM
    f.write(content.encode('utf-16-le'))
print('[Executor] Wrote common.ini with server config')
"

# ── Start services ────────────────────────────────────────────────────

echo "[Executor] Starting MT5 terminal..."
wine "$MT5_PATH" \
    /login:${MT5_LOGIN} \
    /password:${MT5_PASSWORD} \
    /server:${MT5_SERVER} \
    /portable &

echo "[Executor] Waiting for MT5 to initialize (90s)..."
sleep 90

# Verify terminal is still running
if pgrep -f terminal64.exe > /dev/null 2>&1; then
    echo "[Executor] MT5 terminal process is alive."
else
    echo "[Executor] WARNING: MT5 terminal process not found!"
fi

# Check terminal journal for connection status
LOGFILE="$MT5_DIR/logs/$(date -u +%Y%m%d).log"
if [ -f "$LOGFILE" ]; then
    echo "[Executor] MT5 journal (last 20 lines):"
    cat "$LOGFILE" | tr -d '\0' | tail -20
fi

# Dump network connections to see if MT5 connected to broker
echo "[Executor] Active connections:"
ss -tn 2>/dev/null || netstat -tn 2>/dev/null || true

# List server config files
echo "[Executor] Server config files:"
find "$MT5_DIR" -name "servers.dat" -o -name "*.srv" -o -name "common.ini" 2>/dev/null

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
