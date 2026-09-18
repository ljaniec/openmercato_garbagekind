#!/usr/bin/env bash
# Demo end-to-end: generator -> serwer XML-RPC + spooler zrzutu -> klient (pelny) -> klient (przyrostowy).
set -euo pipefail
cd "$(dirname "$0")"

DB=${DB:-legacy/sortownia.db}
WSAD=${WSAD:-legacy/wsad}
PORT=${PORT:-8088}
OUT=${OUT:-out}
# Pauza przed krokiem przyrostowym: musi przekroczyc --reserve-step generatora,
# zeby zdazyl ujawnic sie kolejny ruch ze zbioru zapasowego.
PAUSE=${PAUSE:-21}
URL="http://127.0.0.1:${PORT}/api/api_xml-rpc.php"

echo "== 1/5 generator (baza + poczatkowy zrzut plikowy) =="
python3 legacy/generate.py --db "$DB" --wsad "$WSAD" "${@}"

echo "== 2/5 serwer XML-RPC =="
python3 legacy/server.py --db "$DB" --port "$PORT" &
SERVER_PID=$!
echo "== 3/5 spooler zrzutu plikowego =="
python3 legacy/spooler.py --db "$DB" --wsad "$WSAD" --interval 5 &
SPOOLER_PID=$!
trap 'kill "$SERVER_PID" "$SPOOLER_PID" 2>/dev/null || true' EXIT

python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(60):
    try:
        socket.create_connection(("127.0.0.1", port), 0.2).close()
        sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit("Serwer nie wstal")
PY

echo "== 4/5 klient: pelna migracja =="
python3 client/weberp_sync.py --url "$URL" --wsad "$WSAD" --out "$OUT" --full

echo "== 5/5 klient: synchronizacja przyrostowa (czekam ${PAUSE}s na nowe ruchy) =="
python3 -c "import time,sys; time.sleep(float(sys.argv[1]))" "$PAUSE"
python3 client/weberp_sync.py --url "$URL" --wsad "$WSAD" --out "$OUT"

echo
echo "Pliki w $OUT/:"
ls -la "$OUT"
echo "last_sync: $(cat "$OUT/.last_sync")"
