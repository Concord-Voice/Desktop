#!/usr/bin/env bash
# Self-test for check-native-jsf-profile.sh.
#
# The guard exists because a binding rule nobody checks is a wish. A guard whose
# own detection is never exercised is the same wish one level up — so every rule it
# claims to enforce gets a fixture that must FAIL, and the approved deviations get
# fixtures that must PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="${ROOT}/scripts/check-native-jsf-profile.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# expect_fail <name> <body> [ext]  — the guard must reject this snippet AND say why.
#
# A non-zero exit alone is NOT enough, and that was a real hole: injecting
# `raise SystemExit(1)` at the top of the guard made a crashing, entirely inert
# script score as "caught" on every red case. So the output must also name a rule
# (`AV NNN`) or the diagnosis, which a crash cannot produce. Found by
# @pr-review-toolkit:pr-test-analyzer on PR #3155.
expect_fail() {
  local name="$1"; local body="$2"; local ext="${3:-h}"
  local d="${TMP}/case"; rm -rf "$d"; mkdir -p "$d"
  printf '%s\n' "$body" > "${d}/probe.${ext}"
  # `|| rc=$?` and not a bare assignment: under `set -e` a command substitution that
  # fails ABORTS in an assignment (it does not in an argument), so the bare form
  # killed the suite on its very first red case -- which then printed only the
  # section header and exited 0. The same trap `internal-reference`
  # documents for compose_dotenv_quote.
  # The rule is DERIVED from the case name, so a case labelled "AV 206 ..." must be
  # rejected by AV 206 and not merely rejected. Without this, `expect_fail` accepted
  # any non-zero exit carrying any `AV NNN`, so an alias or allocation fixture could
  # score green while the detector it was written for did nothing -- the fixtures
  # happen to contain bare `int`/`unsigned`, which AV 209 rejects on its own. Found
  # by CodeRabbit on PR #3155.
  #
  # Derived rather than passed as a fifth argument so it cannot be forgotten: a new
  # `expect_fail "AV NNN ..."` case is pinned to its rule the moment it is written.
  # Cases whose name does not start with a rule (the tokeniser and fail-closed ones)
  # keep the loose check, which is correct -- they assert a diagnosis, not a rule.
  local want; want="$(printf '%s' "$name" | grep -oE '^AV [0-9]+' || true)"
  local out rc=0
  out="$("$GUARD" "$d" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  %-52s NOT CAUGHT — guard is vacuous here\n' "$name"; fail=$((fail+1))
  elif [ -n "$want" ] && ! grep -qF "$want" <<<"$out"; then
    printf '  %-52s CAUGHT BY THE WRONG RULE — wanted %s\n' "$name" "$want"; fail=$((fail+1))
  elif grep -qE 'AV [0-9]+|does not exist|contains no C\+\+|cannot tokenise' <<<"$out"; then
    printf '  %-52s caught\n' "$name"; pass=$((pass+1))
  else
    printf '  %-52s EXIT %d BUT NO DIAGNOSIS — a crash, not a catch\n' "$name" "$rc"
    fail=$((fail+1))
  fi
}

# expect_pass <name> <body>  — the guard must accept this snippet
expect_pass() {
  local name="$1"; local body="$2"
  local d="${TMP}/case"; rm -rf "$d"; mkdir -p "$d"
  printf '%s\n' "$body" > "${d}/probe.h"
  if "$GUARD" "$d" >/dev/null 2>&1; then
    printf '  %-52s accepted\n' "$name"; pass=$((pass+1))
  else
    printf '  %-52s FALSE POSITIVE — guard rejects legal code\n' "$name"; fail=$((fail+1))
  fi
}

echo "=== violations the guard MUST catch ==="
expect_fail "AV 208 throw"              'void f() { throw 1; }'
expect_fail "AV 208 try/catch"          'void f() { try { g(); } catch (...) {} }'
expect_fail "AV 206 new"                'u8* f() { return new u8[4]; }'
expect_fail "AV 206 delete"             'void f(u8* p) { delete p; }'
expect_fail "AV 206 malloc"             'void* f() { return malloc(4); }'
expect_fail "AV 206 std::vector"        '#include <vector>
std::vector<u8> v;'
# The two constructs the denylist form missed. Codex found them on PR #3155; both
# were verified to report CLEAN before the allowlist rewrite, so these cases are the
# red half of a real red-green, not decoration.
expect_fail "AV 206 std::unordered_map"  '#include <unordered_map>
std::unordered_map<u32, u32> m;'
expect_fail "AV 206 std::make_unique"    'auto p = std::make_unique<Thing>();'
expect_fail "AV 206 std::basic_string"   'std::basic_string<char> s;'
# Fail-closed means an UNKNOWN name is a violation too -- that is the whole property
# the denylist lacked, and the only case that proves it holds for names nobody has
# thought of yet.
expect_fail "AV 206 unknown std:: name"  'std::future_widget_9000<u8> w;'
# Two evasions that made the allowlist inert, both verified passing the guard
# before this: a C++14 digit separator blanked the rest of the file, and a
# using-directive unqualified every name so the std:: matcher saw nothing. The
# separator case is the important one -- 48'000 is idiomatic in an audio codebase.
expect_fail "digit separator does not blank the file" $'constexpr u32 kFrames = 48\'000u;\nvoid f() { throw 1; }'
expect_fail "AV 206 using namespace"     $'using namespace std;\nvector<u8> v;'
expect_fail "AV 206 std :: with a space" 'std ::vector<u8> v;'
expect_fail "AV 206 std:: split over lines" $'std::\nvector<u8> v;'
# Fail CLOSED on a file the scanner cannot tokenise: blanking to EOF is how a
# guard silently stops checking, which is the same defect one level down.
expect_fail "unterminated string literal" 'const char* k = "never closed;'
expect_fail "AV 22 <cstdio>"            '#include <cstdio>'
expect_fail "AV 25 <ctime>"             '#include <ctime>'
expect_fail "AV 20 <csetjmp>"           '#include <csetjmp>'
expect_fail "AV 189 goto"               'void f() { goto end; end: return; }'
expect_fail "AV 24 exit()"              'void f() { exit(1); }'
expect_fail "AV 209 bare int"           'int counter = 0;'
expect_fail "AV 209 bare double"        'double gain = 1.0;'
expect_fail "AV 209 unsigned"           'unsigned n = 0u;'
expect_fail "AV 209 cast to bare int"   'auto n = static_cast<int>(x);'
# Every fixture wrote probe.h, so the guard scanning ONLY .h survived. rt/ holds
# one header today; the first .cc added would have been invisible.
expect_fail "a .cc file is scanned too"  'void f() { throw 1; }' cc
# AV 24's matcher is a token list, and `\bexit\s*\(` does not match `_exit(`
# because `_` is a word character.
expect_fail "AV 24 _exit()"             'void f() { _exit(1); }'
expect_fail "AV 24 quick_exit()"        'void f() { quick_exit(1); }'
expect_fail "AV 24 popen()"             'void f() { popen("x", "r"); }'
expect_fail "AV 24 setenv()"            'void f() { setenv("A", "B", 1); }'
# The free() rule had no fixture at all -- deleting it outright survived.
expect_fail "AV 206 free()"             'void f(void* p) { free(p); }'
# One line carrying BOTH an approved `= delete` and a real deallocation. The old
# guard skipped the whole line on seeing the first and never saw the second.
expect_fail "real delete beside an = delete"  'struct C { C() = delete; }; void destroy(C* p) { delete p; }'
# An alias reaches std under a different spelling and evaded both the qualified
# matcher and the using-directive ban.
expect_fail "AV 206 namespace alias to std"   $'namespace rt_std = std;\nrt_std::vector<u8> v;'
expect_fail "AV 206 alias to ::std"           'namespace s = ::std;'
expect_fail "AV 206 alias split over lines"    $'namespace rt_std =\n  std;\nrt_std::vector<u8> v;'
# The alias NAME was matched with an ASCII class, and the alias name is chosen by
# whoever writes the code -- so a non-ASCII alias reached the allocating STL with the
# allowlist never consulted. This exited 0 "clean" before PR #3188 while the ASCII
# control two lines above was caught. The AV 206 anchors this PR also fixes rejected
# valid code; THIS one accepted banned code. Found by @security-reviewer + verified
# against a control pair on PR #3188.
expect_fail "AV 206 non-ASCII alias to std"   $'namespace \xc3\xa9std = std;\n\xc3\xa9std::vector<u8> v;'
# A Unicode identifier has TWO source spellings and matching only the decoded one
# left the other half open: a universal-character-name puts a literal BACKSLASH in
# the source, which is not a word character. Both of these compile under the
# -std=c++17 the addon actually builds with, and both exited 0 "clean" against the
# decoded-only fix. Found by Codex on PR #3188, after that fix.
# DECLARATION-ONLY, deliberately. With a `<alias>::vector<u8>` use site the delimited
# form is caught TWICE -- `}` is a non-word character, so `\bstd::` matches inside
# `\u{e9}std::vector` and STD_RE reports it as AV 206 too. The case then scores green
# with ALIAS_RE fully broken, which is the vacuity the suite's own rule-derivation
# exists to prevent and which it cannot see here, because both rules report AV 206.
# Verified: dropping the UCN alternation fails both of these only in this shape.
expect_fail "AV 206 UCN alias to std"         'namespace \u00e9std = std;'
expect_fail "AV 206 delimited-UCN alias"      'namespace \u{e9}std = std;'
# A NAMED universal-character-name is a fourth spelling, and clang takes it as an
# extension at -std=c++17. It defeated a carve-out written for `\u{hex}` specifically,
# which is why the carve-out is now the SHAPE `\<letter>{...}` rather than a token.
# Found by Codex on PR #3189.
expect_fail "AV 206 named-UCN alias"          'namespace \N{LATIN SMALL LETTER E WITH ACUTE}ns = std;'
# U+00B7 MIDDLE DOT is legal in a C++ identifier and is not Python `\w`, so naming
# the alphabet a third time still left a bypass. Found by Codex on PR #3189, after
# the UCN fix. The matcher is structural now; these three pin that it stays that
# way -- each defeats a different attempt to enumerate the alphabet.
expect_fail "AV 206 middle-dot alias"         $'namespace a\xc2\xb7x = std;'
expect_fail "AV 206 NFD alias"                $'namespace e\xcc\x81std = std;'
expect_fail "AV 206 cyrillic alias"           $'namespace \xd0\xb0\xd0\xb1\xd0\xb2 = std;'
# ...and a structural matcher must not over-fire. A namespace body, an alias to
# something that is NOT std, and a name merely ENDING in std are all legal.
expect_pass "alias to a non-std namespace"     'namespace rt_alias = other_ns; void f() { rt_alias::go(); }'
expect_pass "namespace body then other alias"  $'namespace a { }\nnamespace c = other;'
expect_pass "alias to a name ending in std"    'namespace q = notstd;'
# The `;`/`{`/`}` guards on the alias NAME are load-bearing, not tidiness: with a bare
# `.+?` the name spans a namespace body and any identifier called `std` becomes an
# "alias" -- this fixture is legal C++ and was rejected by that mutant. It also fixes
# attribution: with two aliases where only the second is to std, the loose form
# reports line 1. Measured against a `.+?` mutant, which this suite otherwise let live.
expect_pass "identifier named std in a body"   $'namespace rt {\nvoid f(u32 std) { u32 y = std; }\n}'
# A preprocessing directive between `namespace` and its target is not part of the
# alias name. Without excluding `#`, the loose match swallowed one and reported this
# -- legal under clang and gcc at C++17 -- as an alias to std. The false positive the
# structural rewrite introduced. Found by Codex on PR #3189.
expect_pass "directive between namespace and target" $'namespace alias\n#define UNUSED = std;\n= other;\nvoid f() { alias::go(); }'
# ...and `%:` is C++'s digraph spelling of `#`, so excluding the literal character was
# the enumeration mistake one level down. The rule is whitespace instead: an identifier
# cannot contain any, so a directive on its own line cannot be swallowed whatever it is
# spelled with. Found by Codex on PR #3189, immediately after the `#` fix.
expect_pass "digraph directive between ns and target" $'namespace alias\n%:define UNUSED = std;\n= other;\nvoid f() { alias::go(); }'
# A LINE SPLICE is the one whitespace that is part of the name: C++ joins
# backslash-newline in translation phase 2, so this declares `alias` and the
# whitespace rule that blocks directives stopped the match dead at that newline.
# Fail-OPEN, so it is fixed rather than recorded. Found by Codex on PR #3189.
expect_fail "AV 206 line-spliced alias"       $'namespace al\\\nias = std;'
# ...and admitting the splice must not readmit a directive, which is separated by a
# PLAIN newline. Paired with the two directive green cases above: together they pin
# that the name crosses a spliced newline and only a spliced one.
# ...and excluding `#` must not blind the matcher to a real alias that merely FOLLOWS
# a directive.
expect_fail "AV 206 alias after a directive"  $'#define X 1\nnamespace a = std;'
# The UCN class must not swallow an ordinary identifier that merely CONTAINS a `u`:
# a bare `\w*` on either side of the alternation would.
expect_pass "helper named like a UCN prefix"   'void u00e9_helper() {} void f() { u00e9_helper(); }'
expect_fail "AV 206 aligned_alloc"            'void* f(u32 n) { return aligned_alloc(64u, n); }'
expect_fail "AV 206 posix_memalign"           'void f(void** p, u32 n) { posix_memalign(p, 64u, n); }'
expect_fail "AV 206 strdup"                   'char* f(const char* s) { return strdup(s); }'
# A guard naming only `malloc` let the whole Windows CRT allocator pair through:
# `\bmalloc` does not match inside `_aligned_malloc(`. The fix was LISTING each name
# -- `\b` anchors a leading `_` fine, exactly as it does for AV 24's `_exit`. Found
# by Codex on PR #3155; the "`\b` cannot anchor `_`" framing corrected on PR #3188.
expect_fail "AV 206 _aligned_malloc"          'void* f(u32 n) { return _aligned_malloc(n, 64u); }'
expect_fail "AV 206 _aligned_free"            'void f(void* p) { _aligned_free(p); }'
expect_fail "AV 206 _malloca"                 'void* f(u32 n) { return _malloca(n); }'
# `_freea` is the third name in the deallocation pattern and had no red case, so
# dropping it from that alternation survived the whole suite. Found by
# @pr-review-toolkit:pr-test-analyzer on PR #3188.
expect_fail "AV 206 _freea"                   'void f(void* p) { _freea(p); }'
# Every call-shaped pattern writes `\s*` before its `(`, but a PER-LINE scan cannot
# see whitespace that IS a newline: these two reported clean while the guard claimed
# to ban them. Found by Codex on PR #3155.
expect_fail "AV 206 malloc split over lines"  $'void* f(u32 n) {\n  return malloc\n      (n);\n}'
expect_fail "AV 24 system() split over lines" $'void f() {\n  system\n    ("rm -rf /");\n}'

# --- every AV 206 name, drift-checked against the guard -------------------------
#
# The cases above are incident-specific: each one pins a name that a real defect
# let through. That left 18 of the 27 names with no case at all, so any one of them
# could be dropped from its alternation and this suite stayed green -- a vacuity the
# named cases cannot close, because they only ever cover the names someone already
# got wrong. Found by @pr-review-toolkit:pr-test-analyzer on PR #3188.
#
# The list is DERIVED from the guard rather than retyped, so it cannot go stale: a
# name added to either AV 206 alternation appears here automatically and gets a red
# case on the next run. The literal below exists only to detect the reverse -- a name
# silently REMOVED from the guard, which a derived-only list would follow into
# vacuity without complaint. Divergence in either direction fails the suite, which is
# the property that makes this worth more than 27 hand-written cases.
AV206_EXPECTED="malloc calloc realloc reallocarray aligned_alloc memalign posix_memalign \
valloc pvalloc strdup strndup asprintf vasprintf _aligned_malloc _aligned_realloc \
_aligned_recalloc _aligned_offset_malloc _aligned_offset_realloc _aligned_offset_recalloc \
_malloca _recalloc _expand _strdup _wcsdup free _aligned_free _freea"

AV206_ACTUAL="$(python3 - "$GUARD" <<'EXTRACT'
import re, sys, io
src = io.open(sys.argv[1], encoding="utf-8").read()
names = []
# Only the two AV 206 call patterns: regex opens `(?<!\w)(?:` and closes `)\s*\(`.
# AV 24 uses `\b(?:` and AV 209 uses `(?<![\w:])`, so neither is picked up.
for m in re.finditer(r'\(r"\(\?<!\\w\)\(\?:(.*?)\)\\s\*\\\(",', src, re.S):
    blob = re.sub(r'"\s*\n\s*r"', '', m.group(1))
    names += [n for n in blob.split("|") if n]
print(" ".join(names))
EXTRACT
)"

# Both sides go through the SAME normaliser. An earlier revision spelled the two
# `tr` invocations differently and reported DRIFTED on identical lists -- a
# comparison whose sides are normalised differently is its own bug shape.
_norm_names() { printf '%s' "$1" | tr -s '[:space:]' '\n' | grep -v '^$' | sort | tr '\n' ' '; }
if [ "$(_norm_names "$AV206_EXPECTED")" = "$(_norm_names "$AV206_ACTUAL")" ]; then
  printf '  %-52s in step\n' "AV 206 name list matches the guard"; pass=$((pass+1))
else
  printf '  %-52s DRIFTED - guard and test disagree\n' "AV 206 name list matches the guard"
  fail=$((fail+1))
  printf '      guard: %s\n' "$(_norm_names "$AV206_ACTUAL")"
  printf '      test:  %s\n' "$(_norm_names "$AV206_EXPECTED")"
fi

# One red case per name. `u32`/`void*` and not `unsigned`/`int`, so AV 209 cannot be
# what catches these -- expect_fail derives the wanted rule from the case name, so a
# fixture caught by the wrong rule is reported as such rather than scoring green.
for _n in $AV206_ACTUAL; do
  expect_fail "AV 206 name: ${_n}" "void* f(u32 n) { return ${_n}(n); }"
done

echo
echo "=== the guard must FAIL CLOSED when it cannot find its subject ==="
# A guard that passes when its target is gone looks exactly like coverage.
missing="${TMP}/definitely-not-here"
if "$GUARD" "$missing" >/dev/null 2>&1; then
  printf '  %-52s PASSED ON A MISSING DIR — fails OPEN\n' "missing rt/ directory"; fail=$((fail+1))
else
  printf '  %-52s errors\n' "missing rt/ directory"; pass=$((pass+1))
fi
empty="${TMP}/empty"; rm -rf "$empty"; mkdir -p "$empty"
if "$GUARD" "$empty" >/dev/null 2>&1; then
  printf '  %-52s PASSED ON AN EMPTY DIR — vacuous green\n' "rt/ with no C++ sources"; fail=$((fail+1))
else
  printf '  %-52s errors\n' "rt/ with no C++ sources"; pass=$((pass+1))
fi
# ...and a directory holding only NON-C++ files is the same vacuous state.
noncpp="${TMP}/noncpp"; rm -rf "$noncpp"; mkdir -p "$noncpp"; echo "notes" > "${noncpp}/README.md"
if "$GUARD" "$noncpp" >/dev/null 2>&1; then
  printf '  %-52s PASSED — vacuous green\n' "rt/ with only non-C++ files"; fail=$((fail+1))
else
  printf '  %-52s errors\n' "rt/ with only non-C++ files"; pass=$((pass+1))
fi

echo
echo "=== legal code the guard MUST NOT reject ==="
expect_pass "approved deviation: = delete" 'class C { C(const C&) = delete; };'
expect_pass "two = delete on one line"     'class C { C(const C&) = delete; C& operator=(const C&) = delete; };'
expect_pass "fixed-width typedefs"         '#include <cstdint>
std::uint32_t n = 0u;
std::int16_t s = 0;'
expect_pass "std::atomic (approved)"       '#include <atomic>
std::atomic<std::uint32_t> idx;'
expect_pass "std::memcpy into caller storage" '#include <cstring>
void f(void* d, const void* s, std::size_t n) { std::memcpy(d, s, n); }'
# The legal half of the separator fix: a real char literal must still be stripped,
# and an even number of separators must not be read as one.
expect_pass "char literal is still stripped"  $'const char c = \'x\';\nconst char n = \'\\n\';'
expect_pass "even digit separators"           "constexpr u32 kBig = 1'000'000u;"
expect_pass "bool and auto are not bare"   'bool ready = false;
auto x = ready;'
# Prose is the reason the guard strips comments before matching. Without that, the
# words "int", "try" and "new" in a sentence make the guard cry wolf, and a guard
# that cries wolf gets switched off.
expect_pass "forbidden words inside comments" '// We do not allocate: no new, no delete, no int.
/* A retry here would throw, so we do not try. */
constexpr std::uint32_t kN = 4u;'
expect_pass "forbidden words inside strings"  'const char* k = "new int throw";'
# AV 24 matches a COMPLETE identifier. The first repair for `_exit(` used
# `(?:\b|_)`, which read every underscore as an identifier start and rejected these
# ordinary helpers -- valid code failing pre-commit and CI. Found by Codex on
# PR #3155. Paired with the `_exit()` red case above: the two together pin the
# boundary, and either one alone is satisfied by a matcher that is wrong.
expect_pass "helper whose name ends in _abort"  'void request_abort() {} void f() { request_abort(); }'
expect_pass "helper whose name ends in _system" 'void audio_system() {} void f() { audio_system(); }'
expect_pass "helper whose name ends in _signal" 'void ready_signal() {} void f() { ready_signal(); }'
# The lookbehind must not turn into a bare substring match: a pool helper whose
# name merely ENDS in a banned name is legal code.
expect_pass "helper whose name ends in _free"   'void pool_free(void* p) {} void f(void* p) { pool_free(p); }'
expect_pass "helper whose name ends in _malloc" 'void* arena_malloc(u32 n); void* f(u32 n) { return arena_malloc(n); }'
# ...and it must not turn into an ASCII-only boundary either. `\b` is Unicode-aware
# for Python `str`, so the ASCII class `[A-Za-z0-9_]` that replaced it read every
# non-ASCII identifier character as a word boundary and rejected this -- valid C++
# that clang accepts with -fsyntax-only. Paired with the `_aligned_malloc` red case
# above: the two together pin the alphabet, and either one alone is satisfied by a
# matcher that is wrong. Found by Codex on PR #3188.
#
# BOTH names are exercised because the fix changed TWO patterns -- allocation and
# deallocation -- and one fixture pins only one of them. Measured, not assumed: with
# the fix applied to the allocation pattern alone and the deallocation pattern left
# ASCII, a single-`\u00e9malloc` fixture left this suite fully green while the guard still
# rejected `\u00e9free()`. Adding the second name to this one body is what makes the
# half-fix fail. Found by @security-reviewer on PR #3188.
#
# The body is ANSI-C quoted so the U+00E9 is explicit at the point of use rather than
# an invisible glyph in the fixture, and so it stays byte-exact regardless of locale;
# `printf '%s'` does not expand escapes, so a plain '...' would write the backslashes
# literally and test nothing.
expect_pass "non-ASCII identifier ending in a banned name" \
  $'void \xc3\xa9malloc() {} void \xc3\xa9free(void* p) {} void f() { \xc3\xa9malloc(); \xc3\xa9free(0); }'

echo
echo "=== the real rt/ tree must still pass ==="
# An allowlist tight enough to reject the code it guards gets deleted within a week.
if "$GUARD" >/dev/null 2>&1; then
  printf '  %-52s accepted\n' "live concord-audiocap/rt/"; pass=$((pass+1))
else
  printf '  %-52s REJECTS THE REAL TREE\n' "live concord-audiocap/rt/"; fail=$((fail+1))
fi

echo
echo "passed ${pass}, failed ${fail}"
# An assertion FLOOR. Without it, making expect_fail/expect_pass return immediately
# prints "passed 0, failed 0" and exits 0 -- a suite that asserts nothing reporting
# success, which is the same vacuity the guard itself is written against.
MIN_CASES=103
if [ "$((pass + fail))" -lt "$MIN_CASES" ]; then
  echo "ONLY $((pass + fail)) cases ran; expected at least ${MIN_CASES}." >&2
  echo "  A suite that stops asserting must not report success." >&2
  exit 1
fi
[ "$fail" -eq 0 ]
