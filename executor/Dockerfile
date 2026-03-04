FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV WINEDEBUG=-all
ENV WINEPREFIX=/root/.wine

# Install Wine 10.0 from Debian Trixie repos.
# MT5 build 5663 requires Wine 10.0+.
# Debian Trixie ships Wine 10.0 natively (packages compiled for Debian).
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        wget ca-certificates \
        xvfb x11-utils \
        python3 python3-pip python3-venv \
        wine wine64 wine32 \
        cabextract winbind procps p7zip-full unzip && \
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
