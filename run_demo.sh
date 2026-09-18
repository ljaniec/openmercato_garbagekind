#!/usr/bin/env bash
# Demo end-to-end: generator -> serwer -> klient (pelny) -> klient (przyrostowy).
set -euo pipefail
cd "$(dirname "$0")"

DB=${DB:-legacy/sortownia.db}
PORT=${PORT:-8088}
OUT=${OUT:-out}
# Pauza przed krokiem przyrostowym: musi przekroczyc --reserve-step generatora,
# zeby zdazyl ujawnic sie kolejny ruch ze zbioru zapasowego.
PAUSE=${PAUSE:-21}
URL="http://127.0.0.1:${PORT}/api/api_xml-rpc.php"

echo "== 1/4 generator =="
python3 legacy/generate.py --db "$DB" "${@}"

echo "== 2/4 serwer =="
python3 legacy/server.py --db "$DB" --port "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
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

echo "== 3/4 klient: pelna migracja =="
python3 client/weberp_sync.py --url "$URL" --out "$OUT" --full

echo "== 4/4 klient: synchronizacja przyrostowa (czekam ${PAUSE}s na nowe ruchy) =="
python3 -c "import time,sys; time.sleep(float(sys.argv[1]))" "$PAUSE"
python3 client/weberp_sync.py --url "$URL" --out "$OUT"

echo
echo "Pliki w $OUT/:"
ls -la "$OUT"
echo "last_sync: $(cat "$OUT/.last_sync")"
