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

# Helper: patch MT5 binaries to hide Wine detection
patch_mt5_binaries() {
    local mt5dir="$1"
    local mt5exe="$mt5dir/terminal64.exe"
    for BIN in "$mt5exe" "$mt5dir/metatester64.exe" "$mt5dir/metaeditor64.exe"; do
        if [ -f "$BIN" ] && grep -q 'wine_get_version' "$BIN" 2>/dev/null; then
            echo "[Executor] Patching $(basename "$BIN") to hide Wine detection..."
            sed -i 's/wine_get_version/xine_get_version/g' "$BIN"
            sed -i 's/wine_get_build_id/xine_get_build_id/g' "$BIN"
            sed -i 's/wine_get_host_version/xine_get_host_version/g' "$BIN"
        fi
    done
}

# ── Wine + MT5 runtime setup ──────────────────────────────────────────

echo "[Executor] Wine version: $(wine --version 2>&1)"

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
MT5_DIR=$(dirname "$MT5_PATH")

# ── Auto-update + patch loop ──────────────────────────────────────────
# MT5 auto-updates on first launch and exits (code 10056 = restart needed).
# We run it in a loop: patch -> launch -> wait for exit -> re-patch -> repeat
# until the terminal stays running (meaning auto-updates are done).

for ATTEMPT in 1 2 3 4 5; do
    patch_mt5_binaries "$MT5_DIR"

    echo "[Executor] Launch $ATTEMPT: Starting MT5 terminal..."
    set +e
    wine "$MT5_PATH" /portable &

    # Wait up to 60s for this launch cycle
    STAYED=false
    for i in $(seq 1 12); do
        sleep 5
        if ! pgrep -f terminal64.exe > /dev/null 2>&1; then
            echo "[Executor] Launch $ATTEMPT: Terminal exited after $((i * 5))s"
            break
        fi
        if [ $i -eq 12 ]; then
            echo "[Executor] Launch $ATTEMPT: Terminal stayed alive for 60s - update cycle complete"
            STAYED=true
        fi
    done
    set -e
    wait_wine

    LOGFILE="$MT5_DIR/logs/$(date -u +%Y%m%d).log"
    if [ -f "$LOGFILE" ]; then
        echo "[Executor] Launch $ATTEMPT journal (last 10 lines):"
        cat "$LOGFILE" | tr -d '\0' | tail -10
    fi

    if [ "$STAYED" = true ]; then
        echo "[Executor] Terminal is running after launch $ATTEMPT"
        break
    fi

    echo "[Executor] Terminal exited (likely auto-update restart). Retrying..."
    sleep 3
done

# Final re-patch in case the last update replaced the binary
patch_mt5_binaries "$MT5_DIR"

# Kill any leftover terminal from the update loop (we'll start fresh with credentials)
pkill -f terminal64.exe 2>/dev/null || true
wait_wine
sleep 2

# Install Wine Python via embedded zip
PYDIR="$WINEPREFIX/drive_c/Python39"
WINE_PYTHON="$PYDIR/python.exe"

if [ ! -f "$WINE_PYTHON" ]; then
    echo "[Executor] Installing Python 3.9 (embedded zip)..."
    wget -q -O /tmp/python-embed.zip "https://www.python.org/ftp/python/3.9.13/python-3.9.13-embed-amd64.zip"
    mkdir -p "$PYDIR"
    unzip -o /tmp/python-embed.zip -d "$PYDIR" > /dev/null 2>&1
    rm -f /tmp/python-embed.zip

    PTH_FILE=$(ls "$PYDIR"/python*._pth 2>/dev/null | head -1)
    if [ -n "$PTH_FILE" ]; then
        sed -i 's/^#import site/import site/' "$PTH_FILE"
        echo "Lib/site-packages" >> "$PTH_FILE"
    fi
    mkdir -p "$PYDIR/Lib/site-packages"

    echo "[Executor] Installing pip..."
    wget -q -O /tmp/get-pip.py "https://bootstrap.pypa.io/get-pip.py"
    set +e
    wine "$WINE_PYTHON" /tmp/get-pip.py --no-warn-script-location 2>&1
    PIP_EXIT=$?
    set -e
    wait_wine
    rm -f /tmp/get-pip.py
    echo "[Executor] get-pip.py exit code: $PIP_EXIT"

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

# ── Phase 2: Production launch ───────────────────────────────────────

echo "[Executor] Phase 2: Starting MT5 terminal for production..."
wine "$MT5_PATH" \
    /login:${MT5_LOGIN} \
    /password:${MT5_PASSWORD} \
    /server:${MT5_SERVER} \
    /portable &

echo "[Executor] Waiting for MT5 to connect (90s)..."
sleep 90

# Verify terminal is still running
if pgrep -f terminal64.exe > /dev/null 2>&1; then
    echo "[Executor] MT5 terminal process is alive."
else
    echo "[Executor] WARNING: MT5 terminal process not found!"
fi

# Check terminal journal
LOGFILE="$MT5_DIR/logs/$(date -u +%Y%m%d).log"
if [ -f "$LOGFILE" ]; then
    echo "[Executor] MT5 journal (last 30 lines):"
    cat "$LOGFILE" | tr -d '\0' | tail -30
fi

# Show network connections
echo "[Executor] Active connections:"
ss -tn 2>/dev/null || netstat -tn 2>/dev/null || true

# List server config files
echo "[Executor] Server config files:"
find "$MT5_DIR" -name "servers.dat" -o -name "*.srv" -o -name "common.ini" 2>/dev/null
ls -la "$MT5_DIR/Config/" 2>/dev/null

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
