# scripts/public-mirror/lib.sh — shared helpers for the public-mirror publisher.
# Sourced by assemble.sh, transform.sh, publish-gates.sh, publish.sh.
# No side effects on source (define-only), so the test harnesses can source it.
set -u

# Repo root (the Alpha working tree). Overridable for tests via PMIRROR_REPO_ROOT.
pmirror_repo_root() {
  if [ -n "${PMIRROR_REPO_ROOT:-}" ]; then printf '%s\n' "$PMIRROR_REPO_ROOT"; return; fi
  git rev-parse --show-toplevel
}

pmirror_log()  { printf '[public-mirror] %s\n' "$*" >&2; }
pmirror_fail() { printf '[public-mirror] FAIL: %s\n' "$*" >&2; }

# Canonical private-tree cross-reference regex (spec §7 gate #2). The transform
# strips matches; the gate FAILs on any survivor. Both use pmirror_private_refs
# below, including its exact public operator-path exceptions.
PMIRROR_PRIVATE_REF_REGEX='(\.claude/|docs/(adr|superpowers|runbooks|reference|ci|competitive-analysis)/|infrastructure/(deploy|cloudflare|github)/|/CLAUDE\.md|CLAUDE\.md|/TODO\.md|TODO\.md|docs/policies/(update-cert-pinning-runbook|audit-log-retention)\.md)'

# Complete public command/runbook paths only. Never exempt a directory or prefix.
# Runtime-generated path references do not grant filter-manifest file admission.
pmirror_public_operator_path() {
  case "$1" in
    infrastructure/deploy/install-selfhost.sh|infrastructure/deploy/concord-selfhost|\
    infrastructure/deploy/concord-ctl.sh|infrastructure/deploy/selfhost-storage.sh|\
    infrastructure/deploy/selfhost-tls.sh|infrastructure/deploy/selfhost-tls.py|\
    infrastructure/deploy/selfhost-port-posture.py|infrastructure/deploy/provision-cert.sh|\
    infrastructure/deploy/copy-certs.sh|infrastructure/deploy/selfhost-security-event-logging.sh|\
    infrastructure/deploy/nginx/concordvoice.conf|\
    infrastructure/deploy/nginx/concordvoice.rendered.conf|\
    infrastructure/deploy/nginx/admin-console.conf.template|\
    docs/runbooks/selfhost-quickstart.md|docs/runbooks/self-hosted-tls.md|\
    docs/runbooks/selfhost-public-acceptance.md|docs/runbooks/refresh-minio-image.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Shared transform/gate token handling. The shell predicate is the sole exception
# authority; Python keeps replacement and boundary handling identical in both uses.
# scan returns 1 for a private reference, 0 for clean content; errors return 2.
pmirror_private_refs() {
  local mode="$1" file="$2" path
  case "$mode" in transform|scan) ;; *) return 2 ;; esac
  # Most public source has no canonical private reference. Avoid launching the
  # parser for these files; every regex hit still uses the same complete-token
  # boundary parser below. Read/regex errors must never be treated as clean.
  if grep -qE -- "$PMIRROR_PRIVATE_REF_REGEX" "$file"; then
    :
  else
    case "$?" in
      1) return 0 ;;
      *) return 2 ;;
    esac
  fi
  local allowed=()
  while IFS= read -r path; do
    if pmirror_public_operator_path "$path"; then allowed+=( "$path" ); fi
  done < <(grep -oE '(infrastructure/deploy/|docs/runbooks/)[A-Za-z0-9_./-]+' "$file" || true)
  python3 - "$mode" "$file" "$PMIRROR_PRIVATE_REF_REGEX" ${allowed[@]+"${allowed[@]}"} <<'PY'
import re
import sys
from pathlib import Path

try:
    mode, filename, expression, *allowed = sys.argv[1:]
    path = Path(filename)
    content = path.read_bytes().decode("utf-8", errors="surrogateescape")
    private = re.compile(expression)
    # Include suffixes and child components in the token before consulting the
    # predicate. A prefix match must never grant an exception to another path.
    token = re.compile("(?:" + expression + r")[A-Za-z0-9_./-]*")
    delimiter = re.compile(r"[\s`\"'()<>\[\]{},;|&]")
    found = False

    def replace(match):
        global found
        start = match.start()
        preceding = content[:start]
        # ./ is the supported shell-relative spelling. Arbitrary prefixes,
        # absolute paths and traversal components are never public exceptions.
        if preceding.endswith("./"):
            preceding = preceding[:-2]
        # Only known shell/Markdown delimiters terminate an exception. Unknown
        # characters (including ~ backup suffixes) can be valid filename bytes,
        # so the restricted extraction alphabet cannot establish a boundary.
        boundary = not preceding or delimiter.fullmatch(preceding[-1])
        end = match.end()
        trailing_boundary = end == len(content) or delimiter.fullmatch(content[end])
        if boundary and trailing_boundary and match.group() in allowed:
            return match.group()
        found = True
        return private.sub("[internal]", match.group())

    transformed = token.sub(replace, content)
    if mode == "transform":
        if transformed != content:
            path.write_bytes(transformed.encode("utf-8", errors="surrogateescape"))
    elif mode == "scan":
        sys.exit(1 if found else 0)
    else:
        sys.exit(2)
except (OSError, ValueError, re.error):
    sys.exit(2)
PY
}

# Drafting-note publication blockers (spec §7 gate #3). Case-insensitive at use site.
PMIRROR_DRAFTNOTE_REGEX='remove before publication|Drafting notes for review'

# NOTE: the former PMIRROR_DOMAIN_FROM/TO (`concordvoice.chat → example.com`) sanitize
# pass was removed — see transform.sh step (a)'s note and the public-repo-mirror spec §7.
# The hosted domain is public; rewriting it broke the public CI test canary and shipped a
# non-working source tree, while adding no confidentiality (dangerous hosted *defaults* are
# fixed at-source per §7; private cross-refs are stripped by the §7 gate #2 regex above).

# Directories never walked/copied.
PMIRROR_PRUNE_REGEX='/(node_modules|dist|out|coverage|\.git)/|/\.claude/worktrees/'

# ── #1667 release-mirroring helpers (spec 2026-06-20-1667 §3/§4) ──────────────
# Pure (no side effects on source); used by mirror-release.sh and
# test-mirror-release.sh. Keep define-only — lib.sh is sourced by test harnesses.

# Allowlist of release-asset basename globs that may cross to the public repo:
# the installer/manifest/blockmap set Alpha's build-desktop.yml attaches (signed
# installers + electron-updater manifests + blockmaps), plus the detached Linux
# update signatures (`*.sig`) Alpha attaches alongside each .AppImage/.deb/.rpm so
# users can verify the download manually (#653). A non-installer asset
# (e.g. an accidentally-attached secret) cannot cross — spec §12 / D4 defense-in-depth.
# `*.dmg` is included for forward-safety: Alpha's current release glob omits it
# (macOS auto-update reads the `.zip`), but the .dmg is a signed installer Alpha may
# publish later, and it's already-public-by-distribution — so it stays on the allowlist
# rather than being silently dropped if the upstream glob changes.
PMIRROR_RELEASE_ASSET_GLOBS=( '*.exe' '*.zip' '*.dmg' '*.deb' '*.rpm' '*.msi' '*.AppImage' '*.yml' '*.blockmap' '*.sig' )

# Exact public release asset contract for the download site. The mirror may allowlist
# future installer types, but these names are required today because concordvoice.com
# advertises links to them or electron-updater consumes their manifests/blockmaps.
pmirror_expected_release_asset_names() {
  local version="$1" arch
  for arch in arm64 x64; do
    printf 'ConcordVoice-%s-macos-%s.dmg\n' "$version" "$arch"
    printf 'ConcordVoice-%s-macos-%s.zip\n' "$version" "$arch"
    printf 'ConcordVoice-%s-macos-%s.zip.blockmap\n' "$version" "$arch"
    printf 'ConcordVoice-%s-windows-%s-Setup.exe\n' "$version" "$arch"
    printf 'ConcordVoice-%s-linux-%s.AppImage\n' "$version" "$arch"
    printf 'concord-voice_%s_linux-%s.deb\n' "$version" "$arch"
    printf 'concord-voice-%s-linux-%s.rpm\n' "$version" "$arch"
    # Detached Linux update signatures (#653) — required in lockstep with
    # build-desktop.yml's required_assets gate; one `.sig` per Linux installer.
    printf 'ConcordVoice-%s-linux-%s.AppImage.sig\n' "$version" "$arch"
    printf 'concord-voice_%s_linux-%s.deb.sig\n' "$version" "$arch"
    printf 'concord-voice-%s-linux-%s.rpm.sig\n' "$version" "$arch"
  done
  printf 'latest.yml\nlatest-mac.yml\nlatest-linux.yml\n'
}

pmirror_assert_expected_release_assets() {
  local version="$1" expected found name
  shift
  local names=( "$@" )
  local expected_names=() missing=() unexpected=()
  while IFS= read -r expected; do
    expected_names+=( "$expected" )
    found=0
    for name in "${names[@]}"; do
      if [ "$name" = "$expected" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -ne 1 ]; then
      missing+=( "$expected" )
    fi
  done < <(pmirror_expected_release_asset_names "$version")

  for name in "${names[@]}"; do
    found=0
    for expected in "${expected_names[@]}"; do
      if [ "$name" = "$expected" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -ne 1 ]; then
      unexpected+=( "$name" )
    fi
  done

  if [ "${#missing[@]}" -ne 0 ]; then
    pmirror_fail "release desktop-v$version is missing expected public asset(s): ${missing[*]}"
  fi
  if [ "${#unexpected[@]}" -ne 0 ]; then
    pmirror_fail "release desktop-v$version contains unexpected public asset(s): ${unexpected[*]}"
  fi
  [ "${#missing[@]}" -eq 0 ] && [ "${#unexpected[@]}" -eq 0 ]
}

# desktop release tag (desktop-vX.Y.Z) → bare version (X.Y.Z); empty if the tag
# is not a desktop release tag.
pmirror_release_version_from_tag() {
  case "$1" in
    desktop-v*) printf '%s\n' "${1#desktop-v}" ;;
    *)          printf '\n' ;;
  esac
}

# Return 0 iff version >= floor (default 0.2.0). Strips any -pre/+build suffix
# before comparing; version-sort so 0.10.0 > 0.9.0 (D6 / spec §9 v0.2.0+ only).
# NOTE: the suffix strip means an RC of the floor (e.g. 0.2.0-rc1) counts as
# MEETING the floor — a deliberate "v0.2.0 and later, including its pre-releases"
# reading. Alpha tags are bare `desktop-vX.Y.Z` (no suffix), so this only matters
# if a future RC tagging scheme appears; it is intentional, not an accident.
pmirror_release_meets_floor() {
  local v="${1%%[-+]*}" floor="${2:-0.2.0}"
  [ -n "$v" ] || return 1
  # `head -n1` kept: sort must read all input before it emits, so it writes its
  # two-line result once and there is no second write to take SIGPIPE under the
  # `pipefail` this file inherits from its callers. See #3105.
  [ "$(printf '%s\n%s\n' "$floor" "$v" | sort -V | head -n1)" = "$floor" ]
}

# Minimal, leak-safe public release notes (D3): a pointer to the PUBLIC
# CHANGELOG, NOT Alpha's --generate-notes body (which links private PR/issue
# refs — spec §7 cross-ref gate).
pmirror_release_notes() {
  printf 'Signed Concord Voice v%s installers are attached below.\n\nSee [CHANGELOG.md](https://github.com/Concord-Voice/Concord-Voice/blob/main/CHANGELOG.md) for changes in this release.\n' "$1"
}
