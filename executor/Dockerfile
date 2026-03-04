FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV WINEDEBUG=-all
ENV WINEPREFIX=/root/.wine

# Install WineHQ staging (matches official MT5 Linux installer script).
# MT5 build 5663 requires Wine 10.0+; Debian's Wine 8.0 is rejected.
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        wget ca-certificates gnupg2 \
        xvfb x11-utils \
        python3 python3-pip python3-venv \
        cabextract winbind procps p7zip-full unzip curl bc && \
    # Add WineHQ repository (official MT5 installer uses this)
    mkdir -pm755 /etc/apt/keyrings && \
    wget -O - https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key && \
    wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources && \
    apt-get update && \
    apt-get install -y --install-recommends winehq-staging && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Linux Python packages (no Wine needed)
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    numpy \
    mt5linux>=0.0.15 \
    websocket-client>=1.6.0 \
    rpyc==5.3.1

# Copy executor files
WORKDIR /app
COPY trade_executor.py .
COPY start.sh .
RUN chmod +x start.sh

ENTRYPOINT ["/app/start.sh"]
