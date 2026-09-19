#!/usr/bin/env bash
# Wstrzykuje modul sortowni do klonu Open Mercato i wlacza go w apps/mercato.
#
# Turbopack nie rozwiazuje symlinkow poza katalogiem projektu, wiec modul jest
# KOPIOWANY. Zrodlem prawdy zostaje to repozytorium; po kazdej zmianie uruchom
# skrypt ponownie i przegeneruj artefakty (yarn generate).
set -euo pipefail

MERCATO_ROOT=${MERCATO_ROOT:-/home/user/open-mercato/open-mercato}
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$MERCATO_ROOT/apps/mercato/src/modules/sortownia"

[ -d "$MERCATO_ROOT" ] || { echo "Brak klonu Open Mercato: $MERCATO_ROOT" >&2; exit 1; }

rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$HERE/modules/sortownia/." "$TARGET/"
echo "Skopiowano modul do $TARGET"

python3 - "$MERCATO_ROOT" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'apps' / 'mercato'
modules = root / 'src' / 'modules.ts'
text = modules.read_text(encoding='utf-8')
if "id: 'sortownia'" not in text:
    anchor = "  { id: 'ratelimit_probe', from: '@app' },"
    text = text.replace(anchor, anchor + "\n  // Most do systemu legacy sortowni.\n  { id: 'sortownia', from: '@app' },", 1)
    modules.write_text(text, encoding='utf-8')
    print('Wlaczono modul w modules.ts')
else:
    print('Modul juz wlaczony w modules.ts')
PY

echo "Teraz: (cd $MERCATO_ROOT/apps/mercato && yarn generate) i restart dev servera."
