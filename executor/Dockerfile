FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV WINEDEBUG=-all
ENV WINEPREFIX=/root/.wine

# Install dependencies
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        wget gnupg2 software-properties-common ca-certificates \
        xvfb x11-utils \
        python3 python3-pip python3-venv \
        cabextract winbind && \
    # Install Wine
    mkdir -pm755 /etc/apt/keyrings && \
    wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key && \
    wget -NP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources && \
    apt-get update && \
    apt-get install -y --install-recommends winehq-stable && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Initialize Wine prefix
RUN wineboot --init && \
    while pgrep wineserver > /dev/null; do sleep 1; done

# Download and install MT5
RUN wget -O /tmp/mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe" && \
    wine /tmp/mt5setup.exe /auto && \
    while pgrep wineserver > /dev/null; do sleep 1; done && \
    rm -f /tmp/mt5setup.exe

# Install Windows Python inside Wine for MetaTrader5 lib + RPyC
RUN wget -O /tmp/python-3.10.11-amd64.exe "https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe" && \
    wine /tmp/python-3.10.11-amd64.exe /quiet InstallAllUsers=1 PrependPath=1 && \
    while pgrep wineserver > /dev/null; do sleep 1; done && \
    rm -f /tmp/python-3.10.11-amd64.exe

# Install MetaTrader5 and rpyc in Wine Python
RUN wine python -m pip install --no-cache-dir MetaTrader5 rpyc && \
    while pgrep wineserver > /dev/null; do sleep 1; done

# Install Linux Python packages
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    mt5linux>=0.0.15 \
    websocket-client>=1.6.0

# Copy executor files
WORKDIR /app
COPY trade_executor.py .
COPY start.sh .
RUN chmod +x start.sh

ENTRYPOINT ["/app/start.sh"]
