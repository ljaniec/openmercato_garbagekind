#!/usr/bin/env bash
# Wstrzykuje moduly tego repozytorium do klonu Open Mercato i wlacza je
# w apps/mercato.
#
# Turbopack nie rozwiazuje symlinkow poza katalogiem projektu, wiec moduly sa
# KOPIOWANE. Zrodlem prawdy zostaje to repozytorium; po kazdej zmianie uruchom
# skrypt ponownie i przegeneruj artefakty (yarn generate).
#
# Uzycie:
#   ./mercato/install.sh            # wszystkie moduly z mercato/modules
#   ./mercato/install.sh fleet      # wybrane
set -euo pipefail

MERCATO_ROOT=${MERCATO_ROOT:-/home/user/open-mercato/open-mercato}
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$MERCATO_ROOT" ] || { echo "Brak klonu Open Mercato: $MERCATO_ROOT" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  MODULES=("$@")
else
  MODULES=()
  for dir in "$HERE"/modules/*/; do
    MODULES+=("$(basename "$dir")")
  done
fi

for module in "${MODULES[@]}"; do
  SRC="$HERE/modules/$module"
  [ -d "$SRC" ] || { echo "Brak modulu: $SRC" >&2; exit 1; }
  TARGET="$MERCATO_ROOT/apps/mercato/src/modules/$module"
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$SRC/." "$TARGET/"
  echo "Skopiowano $module -> $TARGET"

  python3 - "$MERCATO_ROOT" "$module" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'apps' / 'mercato'
name = sys.argv[2]
modules = root / 'src' / 'modules.ts'
text = modules.read_text(encoding='utf-8')
entry = "{ id: '%s', from: '@app' }" % name
if entry not in text:
    anchor = "  { id: 'ratelimit_probe', from: '@app' },"
    text = text.replace(anchor, anchor + "\n  %s," % entry, 1)
    modules.write_text(text, encoding='utf-8')
    print('  wlaczono %s w modules.ts' % name)
else:
    print('  %s juz wlaczony' % name)
PY
done

echo "Teraz: (cd $MERCATO_ROOT/apps/mercato && yarn generate) i restart dev servera."
