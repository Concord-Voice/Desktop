#!/usr/bin/env bash
# SC2015: `cond && ok … || bad …` is safe here because ok() always returns 0.
# shellcheck disable=SC2015
#
# Tests .github/scripts/generate-desktop-sbom.sh (#218) against small fake
# installers. syft and 7z are stubs: the stub syft reports one npm package per
# node_modules/*/package.json it finds, so the test checks that the script
# unpacked the right installer and extracted app.asar. The real tools ran
# against the real v0.3.1 installers when this landed (see the PR).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/generate-desktop-sbom.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()  { echo "ok:   $1"; pass=$((pass + 1)); }
bad() { echo "FAIL: $1"; [ -n "${2:-}" ] && printf '    %s\n' "${2//$'\n'/$'\n'    }"; fail=$((fail + 1)); }

# make_asar OUT [ENTRY_NAME]: an app.asar holding node_modules/<entry>/package.json.
make_asar() {
  python3 - "$1" "${2:-dep}" <<'PY'
import json, struct, sys
out, name = sys.argv[1], sys.argv[2]
data = b'{"name":"dep","version":"1.2.3"}'
tree = {"files": {"node_modules": {"files": {name: {"files": {
    "package.json": {"offset": "0", "size": len(data)}}}}}}}
js = json.dumps(tree).encode()
pad = (4 - len(js) % 4) % 4
header = struct.pack('<II', 4 + len(js) + pad, len(js)) + js + b'\0' * pad
open(out, 'wb').write(struct.pack('<II', 4, len(header)) + header + data)
PY
}

mkdir -p "$WORK/bin"
cat > "$WORK/bin/syft" <<'STUB'
#!/usr/bin/env bash
# syft scan dir:<root> ... -o cyclonedx-json=<file>
root=${2#dir:}
for a in "$@"; do case $a in cyclonedx-json=*) out=${a#cyclonedx-json=} ;; esac; done
if [ -n "${SYFT_STUB_EMPTY:-}" ]; then echo '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}' > "$out"; exit 0; fi
find "$root" -path '*/node_modules/*/package.json' | while read -r p; do
  n=$(basename "$(dirname "$p")"); printf '{"type":"library","name":"%s","purl":"pkg:npm/%s@1.2.3"}\n' "$n" "$n"
done | jq -s '{bomFormat: "CycloneDX", specVersion: "1.6", components: .}' > "$out"
STUB
# 7z x -y -bd -o<dir> <file>: the installer holds $PLUGINSDIR/app-64.7z, which holds resources/.
cat > "$WORK/bin/7z" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do case $a in -o*) dest=${a#-o} ;; esac; done
src=${!#}
mkdir -p "$dest"
case $src in
  *Setup.exe) mkdir -p "$dest/\$PLUGINSDIR" && cp "$src" "$dest/\$PLUGINSDIR/app-64.7z" ;;
  *.7z) mkdir -p "$dest/resources" && cp "$FIXTURE_ASAR" "$dest/resources/app.asar" \
          && printf 'addon' > "$dest/resources/concord_audiocap.node" ;;
esac
STUB
chmod +x "$WORK/bin/syft" "$WORK/bin/7z"

run() { # $1 = artifact dir; sets OUT, RC, SBOM
  SBOM="$(mktemp "$WORK/out.XXXXXX")"
  OUT=$(PATH="$WORK/bin:$PATH" MIN_NPM="${MIN_NPM:-1}" bash "$SCRIPT" "$1" "$SBOM" 2>&1); RC=$?
}
leg() { # $1 = label; prints a new, empty release-artifact directory
  local d; d="$(mktemp -d "$WORK/leg.XXXXXX")/concord-voice-$1-v9.9.9"; mkdir "$d"; echo "$d"
}
npm_names() { jq -r '[.components[] | select(.purl // "" | startswith("pkg:npm/")) | .name] | join(" ")' "$SBOM"; }
addon() { jq -r --arg f "$1" '.components[] | select(.name == "concord_audiocap") | if $f == "path" then .properties[0].value else .hashes[0].content end' "$SBOM"; }

make_asar "$WORK/app.asar"
export FIXTURE_ASAR="$WORK/app.asar"
ADDON_SHA=$(printf 'addon' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)

# ── macOS: the .zip, with __MACOSX metadata ignored ─────────────────────────
D=$(leg macos-arm64)
APP="$WORK/mac/Concord Voice.app/Contents/Resources"
mkdir -p "$APP" "$WORK/mac/__MACOSX/Concord Voice.app/Contents/Resources"
cp "$WORK/app.asar" "$APP/app.asar"
cp "$WORK/app.asar" "$WORK/mac/__MACOSX/Concord Voice.app/Contents/Resources/app.asar"
printf 'addon' > "$APP/concord_audiocap.node"
mkdir -p "$D/zip/darwin/arm64"
(cd "$WORK/mac" && zip -qr "$D/zip/darwin/arm64/ConcordVoice-9.9.9-macos-arm64.zip" .)
printf 'dmg' > "$D/ConcordVoice-9.9.9-macos-arm64.dmg"
run "$D"
[ "$RC" -eq 0 ] && [ "$(npm_names)" = "dep" ] && [ "$(addon sha)" = "$ADDON_SHA" ] \
  && [ "$(addon path)" = "Concord Voice.app/Contents/Resources/concord_audiocap.node" ] \
  && ok "macOS: unpacks the .zip, extracts app.asar, adds the .node addon with its SHA-256" \
  || bad "macOS leg" "rc=$RC"$'\n'"$OUT"

# ── Linux: the .deb (the rpm and AppImage hold the same app) ────────────────
D=$(leg linux-x64)
mkdir -p "$WORK/deb/data/usr/lib/concord-voice/resources" "$WORK/deb/pkg"
cp "$WORK/app.asar" "$WORK/deb/data/usr/lib/concord-voice/resources/app.asar"
(cd "$WORK/deb/data" && tar -czf "$WORK/deb/pkg/data.tar.gz" . && tar -czf "$WORK/deb/pkg/control.tar.gz" .)
printf '2.0\n' > "$WORK/deb/pkg/debian-binary"
mkdir -p "$D/deb/x64"
# Written by hand: the ar on macOS adds a symbol table and drops non-Mach-O members.
python3 - "$WORK/deb/pkg" "$D/deb/x64/concord-voice_9.9.9_amd64.deb" <<'PY2'
import os, sys
src, out = sys.argv[1], sys.argv[2]
with open(out, 'wb') as o:
    o.write(b'!<arch>\n')
    for name in ('debian-binary', 'control.tar.gz', 'data.tar.gz'):
        data = open(os.path.join(src, name), 'rb').read()
        o.write(f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode() + data + b'\n' * (len(data) % 2))
PY2
printf 'rpm' > "$D/concord-voice-9.9.9.x86_64.rpm"
run "$D"
[ "$RC" -eq 0 ] && [ "$(npm_names)" = "dep" ] && [ -z "$(addon path)" ] \
  && ok "Linux: unpacks the .deb data and extracts app.asar" \
  || bad "Linux leg" "rc=$RC"$'\n'"$OUT"

# ── Windows: the NSIS installer and its inner app-64.7z ─────────────────────
D=$(leg windows-x64)
printf 'exe' > "$D/ConcordVoice-9.9.9-windows-x64-Setup.exe"
run "$D"
[ "$RC" -eq 0 ] && [ "$(npm_names)" = "dep" ] && [ "$(addon path)" = "resources/concord_audiocap.node" ] \
  && ok "Windows: unpacks the installer and its app-*.7z" \
  || bad "Windows leg" "rc=$RC"$'\n'"$OUT"

# ── refusals ────────────────────────────────────────────────────────────────
D=$(leg linux-arm64)
printf 'rpm' > "$D/concord-voice.rpm"
run "$D"
[ "$RC" -ne 0 ] && grep -q 'expected exactly one' <<<"$OUT" \
  && ok "a leg with no supported installer fails" || bad "no installer must fail" "$OUT"

D=$(leg windows-arm64)
printf 'exe' > "$D/a-Setup.exe"; printf 'exe' > "$D/b-Setup.exe"
run "$D"
[ "$RC" -ne 0 ] && grep -q 'found 2, 0, 0' <<<"$OUT" \
  && ok "two installers in one leg fail" || bad "two installers must fail" "$OUT"

D=$(leg macos-x64)
mkdir -p "$WORK/empty/Concord Voice.app"; printf x > "$WORK/empty/Concord Voice.app/x"
(cd "$WORK/empty" && zip -qr "$D/a.zip" .)
run "$D"
[ "$RC" -ne 0 ] && grep -q 'exactly one app.asar' <<<"$OUT" \
  && ok "an installer without app.asar fails" || bad "no app.asar must fail" "$OUT"

make_asar "$WORK/evil.asar" '..'
D=$(leg macos-x64)
mkdir -p "$WORK/evil/Concord Voice.app"; cp "$WORK/evil.asar" "$WORK/evil/Concord Voice.app/app.asar"
(cd "$WORK/evil" && zip -qr "$D/a.zip" .)
run "$D"
[ "$RC" -ne 0 ] && grep -q 'bad app.asar entry name' <<<"$OUT" \
  && ok "an app.asar entry named .. is refused" || bad "a .. entry must be refused" "$OUT"

D=$(leg windows-x64)
printf 'exe' > "$D/ConcordVoice-9.9.9-windows-x64-Setup.exe"
SYFT_STUB_EMPTY=1 run "$D"
[ "$RC" -ne 0 ] && grep -q 'fewer than 1 npm packages' <<<"$OUT" \
  && ok "an SBOM with no npm package fails" || bad "an empty SBOM must fail" "$OUT"

D=$(leg windows-x64)
printf 'exe' > "$D/ConcordVoice-9.9.9-windows-x64-Setup.exe"
MIN_NPM=2 run "$D"
[ "$RC" -ne 0 ] && grep -q 'fewer than 2 npm packages' <<<"$OUT" \
  && ok "an SBOM below the npm package floor fails" || bad "a gutted SBOM must fail" "$OUT"

D=$(leg windows-x64)
printf 'exe' > "$D/ConcordVoice-9.9.9-windows-x64-Setup.exe"
OUT=$(cd "$(dirname "$D")" && PATH="$WORK/bin:$PATH" MIN_NPM=1 bash "$SCRIPT" "$(basename "$D")" "$WORK/rel.cdx.json" 2>&1); RC=$?
[ "$RC" -eq 0 ] && ok "a relative artifact directory works" || bad "a relative artifact directory must work" "$OUT"

echo "─────────────────────────────────"
echo "generate-desktop-sbom test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
