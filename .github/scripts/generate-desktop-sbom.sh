#!/usr/bin/env bash
# Writes the CycloneDX SBOM for one Desktop release artifact (#218).
#
#   generate-desktop-sbom.sh ARTIFACT_DIR OUT_FILE
#
# ARTIFACT_DIR is one downloaded release artifact (concord-voice-<label>-v<version>).
# The script unpacks the leg's installer (Windows *Setup.exe, macOS .zip, Linux
# .deb), extracts app.asar next to itself, and scans the installed tree with
# syft. The SBOM lists every npm package in app.asar, plus each shipped .node
# addon (with its SHA-256), which syft does not catalog on its own.
#
# The release workflow runs this in a job with no id-token: syft is a
# third-party binary, and this script only produces data. app.asar is read by
# the stdlib extractor below, so no npm code runs here either.
#
# Needs: syft (or $SYFT), python3, jq, unzip; 7z for Windows; ar and tar for Linux.
set -euo pipefail

die() { echo "::error::generate-desktop-sbom: $*" >&2; exit 1; }
[ $# -eq 2 ] || die "usage: generate-desktop-sbom.sh ARTIFACT_DIR OUT_FILE"
dir=$1 out=$2
[ -d "$dir" ] || die "no artifact directory $dir"
name=$(basename "$dir")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/root"
mkdir -p "$root"

count() { find "$1" -type f -name "$2" | wc -l | tr -d ' '; }
exes=$(count "$dir" '*Setup.exe') zips=$(count "$dir" '*.zip') debs=$(count "$dir" '*.deb')

# One installer per leg. macOS ships a .dmg with the same app as the .zip, and
# Linux an .rpm and AppImage with the same app as the .deb.
case "$exes$zips$debs" in
  100)
    # NSIS keeps the app as $PLUGINSDIR/app-<arch>.7z inside the installer.
    7z x -y -bd -o"$work/nsis" "$(find "$dir" -type f -name '*Setup.exe')" >/dev/null
    [ "$(count "$work/nsis" 'app-*.7z')" -eq 1 ] || die "$name: expected one app-*.7z in the installer"
    7z x -y -bd -o"$root" "$(find "$work/nsis" -type f -name 'app-*.7z')" >/dev/null ;;
  010)
    unzip -q "$(find "$dir" -type f -name '*.zip')" -x '__MACOSX/*' -d "$root" ;;
  001)
    (cd "$work" && ar x "$(find "$dir" -type f -name '*.deb')")
    [ "$(count "$work" 'data.tar*')" -eq 1 ] || die "$name: expected one data.tar in the .deb"
    tar -xf "$(find "$work" -maxdepth 1 -type f -name 'data.tar*')" -C "$root" ;;
  *)
    die "$name: expected exactly one *Setup.exe, .zip or .deb (found $exes, $zips, $debs)" ;;
esac

[ "$(count "$root" app.asar)" -eq 1 ] || die "$name: expected exactly one app.asar in the installer"
asar=$(find "$root" -type f -name app.asar)

# app.asar: an 8-byte size pickle, a header pickle holding the JSON file tree,
# then the file bytes. Directories hold "files"; a file holds offset and size.
# ponytail: links and "unpacked" entries are skipped. forge.config.ts sets no
# unpack, and syft scans an app.asar.unpacked directory on disk anyway.
python3 -I - "$asar" "${asar%.asar}" <<'PY'
import json, os, struct, sys
src, dest = sys.argv[1], sys.argv[2]
with open(src, 'rb') as f:
    header_size = struct.unpack('<I', f.read(8)[4:8])[0]
    header = f.read(header_size)
    length = struct.unpack('<I', header[4:8])[0]
    tree = json.loads(header[8:8 + length])
    base = 8 + header_size

    def walk(node, rel):
        for entry_name, entry in node['files'].items():
            if entry_name in ('', '.', '..') or any(c in entry_name for c in '/\\\0'):
                raise SystemExit(f'bad app.asar entry name {entry_name!r}')
            path = os.path.join(dest, rel, entry_name)
            if 'files' in entry:
                os.makedirs(path, exist_ok=True)
                walk(entry, os.path.join(rel, entry_name))
            elif 'link' not in entry and not entry.get('unpacked'):
                f.seek(base + int(entry['offset']))
                with open(path, 'wb') as o:
                    o.write(f.read(int(entry['size'])))

    os.makedirs(dest)
    walk(tree, '')
PY

# The "image" set holds the catalogers for an installed tree: each
# node_modules/*/package.json, not a lockfile.
"${SYFT:-syft}" scan "dir:$root" --override-default-catalogers image \
  --source-name "$name" -q -o "cyclonedx-json=$work/syft.json"

# The .node addons, by path under the install root and SHA-256.
addons='[]'
while IFS= read -r f; do
  [ -n "$f" ] || continue
  sum=$( (sha256sum "$root/$f" 2>/dev/null || shasum -a 256 "$root/$f") | cut -d' ' -f1)
  addons=$(jq -c --arg p "${f#./}" --arg s "$sum" \
    '. + [{type: "library", name: ($p | split("/") | last | sub("[.]node$"; "")),
           hashes: [{alg: "SHA-256", content: $s}],
           properties: [{name: "concord:installPath", value: $p}]}]' <<<"$addons")
done < <(cd "$root" && find . -type f -name '*.node' | LC_ALL=C sort)

jq --argjson addons "$addons" '.components = ((.components // []) + $addons)' "$work/syft.json" > "$out"

# Fail rather than publish an empty SBOM: a cataloger change in syft would
# otherwise pass silently.
jq -e '.bomFormat == "CycloneDX" and ([.components[] | select((.purl // "") | startswith("pkg:npm/"))] | length > 0)' \
  "$out" >/dev/null || die "$name: the SBOM lists no npm package"
echo "$name: $(jq '[.components[] | select((.purl // "") | startswith("pkg:npm/"))] | length' "$out") npm package(s), $(jq length <<<"$addons") .node addon(s)"
