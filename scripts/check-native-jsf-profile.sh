#!/usr/bin/env bash
# Mechanically enforce the JSF++ profile inside concord-audiocap/rt/.
#
# internal-reference declares AV 206/208/189/22/24/209 as BINDING in
# rt/. A binding rule nobody checks is a wish, and these particular rules are the
# ones a reviewer reads past most easily — a std::vector in an audio callback looks
# like ordinary C++ right up until it allocates on a real-time thread and the user
# hears it.
#
# Scope is rt/ ONLY. napi/ allocates by necessity (N-API must, to create JS values)
# and that is an approved deviation, not an oversight. test/ asserts and prints,
# which is what it is for. Widening this script to either would produce noise that
# ends with the script being disabled, which is worse than not having it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# An explicit path argument exists so the self-test can point this at a fixture
# tree. Without it the guard could only ever be run against the real rt/, and a
# guard whose own detection is never exercised is the same wish it replaced.
RT_DIR="${1:-${ROOT}/client/desktop/native/concord-audiocap/rt}"

# A MISSING DIRECTORY IS AN ERROR, not a pass. This branch used to exit 0 with a
# "does not exist yet" note, which was right for exactly one moment: before rt/ was
# created. rt/ is tracked now, so a missing directory means it was renamed, moved, or
# deleted — and exiting 0 would make both the pre-commit hook and the CI job report
# success while checking nothing at all. A guard that passes when it cannot find its
# subject is worse than no guard: it looks like coverage. Found by CodeRabbit on
# PR #3155.
if [ ! -d "$RT_DIR" ]; then
  echo "check-native-jsf-profile: ${RT_DIR} does not exist." >&2
  echo "  rt/ is tracked, so this means it was renamed, moved, or deleted. If that" >&2
  echo "  was deliberate, update RT_DIR here and the paths in" >&2
  echo "  internal-reference together." >&2
  exit 1
fi

python3 - "$RT_DIR" <<'PY'
import os, re, sys

rt = sys.argv[1]

# (regex, rule, what it means). Every entry names its AV rule so a failure sends the
# reader to internal-reference rather than to an argument.
CHECKS = [
    (r"\bthrow\b",                          "AV 208", "no C++ exceptions"),
    (r"\bcatch\b",                          "AV 208", "no C++ exceptions"),
    (r"\btry\b",                            "AV 208", "no C++ exceptions"),
    (r"\bnew\b",                            "AV 206", "no free-store allocation"),
    # Named as a SET rather than the original three, because "malloc, calloc,
    # realloc" is a list of the ones that came to mind and the heap does not care.
    # An rt/ fixture calling aligned_alloc(64u, n) reported clean; so did
    # posix_memalign, which the report did not even name. strdup and asprintf are
    # here for the same reason -- they allocate and are easy to read as string
    # helpers. Found by Codex on PR #3155.
    # `\bmalloc` never matches inside `_aligned_malloc(`, so a guard naming malloc
    # let the whole Windows CRT allocator pair through. Found by Codex on PR #3155
    # -- twice, since the first widening added aligned_alloc without noticing
    # _aligned_malloc. The fix was LISTING each `_`-prefixed name, exactly as AV 24
    # lists `_exit`: `\b` anchors a leading underscore perfectly well (it holds
    # before the `_` of ` _aligned_malloc(`, because a space is not a word
    # character), which the AV 24 comment below states and this comment used to
    # deny. Corrected on PR #3188 -- the denial was measurably false, and a comment
    # that misnames the defect it records sends the next reader at the wrong fix.
    #
    # The anchor is spelled `(?<!\w)` rather than `\b`. For THIS pattern the two are
    # provably identical -- every alternative begins with a word character, so `\b`
    # can only hold where the preceding character is not one -- and the lookbehind
    # is kept for the property `\b` does not have: it still anchors correctly if a
    # future alternative is ever added that does NOT begin with a word character.
    # AV 209 below already uses the same lookbehind form.
    #
    # The class is `\w` and NOT `[A-Za-z0-9_]`. `\b` is defined against `\w`, which
    # Python matches over the whole of Unicode for `str`, so spelling the class out
    # in ASCII did not restate `\b` -- it narrowed its alphabet, and any non-ASCII
    # identifier character sitting immediately before a banned name read as a word
    # boundary. `void \u00e9malloc()` -- valid C++ that clang accepts -- was rejected
    # as AV 206. `\w` already includes `_`, so the CRT names are unaffected. Found
    # by Codex on PR #3188.
    #
    # KNOWN RESIDUE, and it fails CLOSED: `\w` is not C++'s identifier set. It
    # excludes combining marks, so the DECOMPOSED spelling of the same identifier
    # (`e` + U+0301 rather than U+00E9) still reads as a boundary and is still
    # rejected -- and macOS produces NFD routinely. U+00A8, U+00AD and U+00B7 are
    # legal in C++ identifiers and are not `\w` either. The same applies to an
    # identifier written with a SOURCE-SPELLED escape: `void \u{e9}malloc()` compiles,
    # and the `}` before `malloc` is not `\w`, so this anchor fires on it. Reported
    # separately by Codex on PR #3189 and recorded rather than fixed, because closing
    # it means teaching these anchors to parse escapes -- which is what the ALIAS
    # matcher below had to do, and it needed five rounds to get right for a name it
    # must match WHOLE. These anchors only need a boundary, and the cost of being
    # wrong here is a rejected identifier nobody will write. Left as-is deliberately:
    # Python's stdlib `re` has no `\p{Mn}`, so closing it means enumerating
    # combining ranges by hand, and a partial enumeration would look complete while
    # being wrong -- which is the exact mistake the ASCII class already made here
    # once. Rejecting valid code is noise; it admits nothing.
    (r"(?<!\w)(?:malloc|calloc|realloc|reallocarray|aligned_alloc"
     r"|memalign|posix_memalign|valloc|pvalloc|strdup|strndup|asprintf|vasprintf"
     r"|_aligned_malloc|_aligned_realloc|_aligned_recalloc|_aligned_offset_malloc"
     r"|_aligned_offset_realloc|_aligned_offset_recalloc|_malloca|_recalloc"
     r"|_expand|_strdup|_wcsdup)\s*\(",
                                            "AV 206", "no free-store allocation"),
    (r"(?<!\w)(?:free|_aligned_free|_freea)\s*\(",
                                            "AV 206", "no free-store deallocation"),
    (r"<stdio\.h>|<cstdio>",                "AV 22",  "no <stdio.h>"),
    (r"<time\.h>|<ctime>",                  "AV 25",  "no <time.h>"),
    (r"<setjmp\.h>|<csetjmp>",              "AV 20",  "no setjmp/longjmp"),
    (r"\bgoto\b",                           "AV 189", "no goto"),
    # An allowlist over `std::` names is only as good as the names STAYING
    # qualified. `using namespace std;` unqualifies every one of them and makes
    # the AV 206 check below inert -- verified on a fixture: `using namespace std;`
    # plus a bare `vector<char8_t> v;` exits 0. There is no legitimate use of it in
    # rt/, so it is simply banned rather than parsed around. Found by
    # @code-reviewer on PR #3155.
    (r"\busing\s+namespace\b",              "AV 206",
                                            "using-directive unqualifies std:: names and defeats the allowlist"),
    # An ALIAS reaches std under a different spelling: `namespace rt_std = std;`
    # then `rt_std::vector<u8>` matches neither the qualified-name allowlist nor
    # the using-directive ban above. Verified evading both before this line.
    # Found by CodeRabbit on PR #3155.
    # Every banned name is spelled OUT, and each is anchored with `\b` at the start
    # of a complete identifier. `\bexit\s*\(` alone does not match `_exit(` -- `_`
    # is a word character, so there is no boundary inside `_exit` -- and `system()`
    # in an audio callback passed a guard that claimed to ban it. Found by
    # @pr-review-toolkit:pr-test-analyzer on PR #3155.
    #
    # The first repair for that was `(?:\b|_)`, which treated EVERY underscore as
    # an identifier start and so rejected `request_abort()` and `audio_system()` --
    # ordinary helpers that call nothing banned -- failing pre-commit and CI on
    # valid code. Listing `_exit` as its own alternative gets the real name without
    # that cost: `\b` holds before the `_` of ` _exit(` (space is not a word
    # character) and does NOT hold before the `_` of `request_abort(`. Found by
    # Codex on PR #3155.
    (r"\b(?:abort|_exit|exit|quick_exit|at_quick_exit|atexit|getenv|setenv"
     r"|putenv|unsetenv|system|popen|pclose|raise|signal)\s*\(",
                                            "AV 24",  "no process/environment/signal library call"),
    # AV 209: fixed-width typedefs only. `bool` and `auto` are not on the list --
    # neither has the width ambiguity the rule is about.
    (r"\b(?:unsigned|signed)\b|(?<![\w:])(?:int|short|long|float|double)\b",
                                            "AV 209", "no bare int/short/long/float/double"),
]

# `= delete` is an APPROVED deviation (C++11 constructs strengthen what JSF++ Rev C
# was protecting), so the allocation check must not fire on it. Checked as an
# exemption rather than by omitting `delete` entirely, so a real `delete p;` is
# still caught.
DELETE_RE   = re.compile(r"\bdelete\b")
EQ_DELETE_RE = re.compile(r"=\s*delete\b")

# AV 206, the STL half, is an ALLOWLIST and must stay one. It used to be a denylist
# of eight container names, which meant every allocating construct nobody happened to
# think of -- std::unordered_map, std::make_unique, std::basic_string -- passed both
# pre-commit and CI while the guard reported the file clean. A guard whose default
# answer is "fine" enforces only the imagination of whoever last edited it. Found by
# Codex on PR #3155, reproduced against a fixture before this rewrite.
#
# So: every std:: name is a violation unless it is named here as provably
# non-allocating. Adding a name is a deliberate act with a reason, which is the
# property the denylist could not have.
# Whitespace-tolerant, because `std ::vector` and `std::` with the name on the
# next line are both legal C++ and both evaded the tight form.
STD_RE = re.compile(r"\bstd\s*::\s*([^\W\d]\w*)", re.S)
# Whole-file and whitespace-tolerant for the same reason STD_RE is: `namespace
# rt_std =` on one line and `std;` on the next is legal C++ and evaded the
# per-line form entirely. Found by Codex on PR #3155.
# The alias NAME is `[^\W\d]\w*` -- a Unicode identifier -- and not the ASCII
# `[A-Za-z_][A-Za-z0-9_]*` it used to be. That ASCII class was a FAIL-OPEN: the
# alias name is chosen by whoever writes the code, so `namespace \u00e9std = std;`
# matched nothing here, `\u00e9std::vector<u8>` matched nothing in STD_RE (correctly --
# `\u00e9std` is a different namespace, and STD_RE's `\b` is Unicode-aware), and the
# allowlist was never consulted at all. Verified: that pair exits 0 "clean" under
# the old class and is caught under this one, while the ASCII control
# `namespace rt_std = std;` is caught under both. Same ASCII-narrowing defect as
# the AV 206 anchors above, but in the direction that matters -- those rejected
# valid code, this ACCEPTED banned code. Found on PR #3188.
#
# ...and then the alphabet was wrong TWICE more, which is the actual lesson here.
# The decoded-only class missed the universal-character-name spelling of the same
# alias (`namespace \u00e9std = std;` puts a literal backslash in the source, which is
# not a word character). Adding UCN handling still missed U+00B7 MIDDLE DOT, which
# C++ permits in an identifier and Python's `\w` does not -- `namespace a\u00b7x = std;`
# compiles under -std=c++17 and exited 0 "clean". Both found by Codex on PR #3189,
# one after each attempt to name the alphabet correctly.
#
# So this matcher no longer names the alphabet at all. Three attempts to enumerate
# "what C++ allows in an identifier" produced three bypasses, and there is no fourth
# attempt that is obviously right: `\w` is not C++'s identifier set, Python's stdlib
# `re` has no `\p{...}` to ask with, and Annex E is a moving target across standards.
# The alias name is now matched STRUCTURALLY -- anything at all between `namespace`
# and `= std;` -- which is fail-CLOSED by construction, because over-matching this
# shape can only catch more and there is no legal `namespace <x> = std;` to protect.
# `=`, `;`, `{` and `}` are excluded so the name cannot span a statement or a
# namespace body -- with one exception carved back in, because excluding braces
# outright also excluded BRACE-DELIMITED ESCAPES, whose own braces are part of a
# single identifier character. That regression was caught by a control matrix, not by
# reading the pattern: `namespace \u{e9}std = std;` went from caught to clean when the
# brace guard went in.
#
# The carve-out is `\<letter>{...}` -- the SHAPE of a brace-delimited escape -- and
# not the `\u{...}` token it started as. Naming the token was the fourth alphabet
# mistake in this matcher: clang also accepts a NAMED universal-character-name,
# `\N{LATIN SMALL LETTER E WITH ACUTE}`, as an extension at -std=c++17, and that
# spelling walked through a carve-out written for `\u{hex}`. Found by Codex on
# PR #3189. A namespace body is unaffected -- its `{` is not preceded by a backslash
# and a letter -- so the guard against spanning a body still holds.
#
# WHITESPACE is excluded, and that is the whole directive defence. A preprocessing
# directive between the `namespace` keyword and its target is not part of the alias
# name, and the loose match swallowed one: `namespace alias` / `#define UNUSED = std;`
# / `= other;` compiles at C++17 and was reported as an AV 206 alias -- a FALSE
# POSITIVE this matcher introduced, and the predicted cost of loosening it.
#
# The first repair excluded the literal `#`, and that was the enumeration mistake
# again one level down: C++ also spells `#` as the digraph `%:`, so `%:define` walked
# through a guard written for `#`. Both found by Codex on PR #3189, one after the
# other. Rather than adding `%` and then waiting for the next spelling, the rule is
# now the one property that cannot vary: AN IDENTIFIER CANNOT CONTAIN WHITESPACE. A
# directive is always separated from the alias name by a newline, so excluding `\s`
# stops the match before ANY directive spelling -- `#`, `%:`, and whatever else --
# without naming one of them.
#
# The brace-escape alternative is what keeps `\N{LATIN SMALL LETTER E WITH ACUTE}`
# working, since that one identifier character legitimately contains spaces.
#
# A LINE SPLICE is the one whitespace that IS part of the name. C++ joins
# backslash-newline in translation phase 2, before tokenising, so `namespace al\` /
# `ias = std;` declares `alias` -- and the whitespace rule above, which is otherwise
# what blocks directives, stopped the match dead at that newline. Fail-OPEN, so it is
# fixed rather than recorded. Found by Codex on PR #3189.
#
# Splicing the source instead would be the more principled fix and is deliberately
# NOT done: removing a backslash-newline removes a newline, which shifts every line
# number after it, and this guard's whole output is line numbers. Admitting the
# splice as one more identifier-character spelling keeps offsets exact. It does not
# reopen the directive hole -- a directive is preceded by a PLAIN newline, and even a
# spliced `#defi\`/`ne` still needs a space before its `= std;`.
#
# NOTE the polarity, because it is why this one is a bypass and the AV 206 residue
# above is only noise. The anchors above put the alphabet in a NEGATIVE LOOKBEHIND,
# so a character `\w` does not know about makes them fire MORE (a false positive,
# fail-closed). This pattern has to MATCH the whole name, so a character it does not
# know about makes it fire LESS -- the match breaks and the alias walks through. The
# same gap, opposite direction, and only one of the two is dangerous.
ALIAS_RE = re.compile(r"\bnamespace\s+(?:[^\s=;{}]|\\[A-Za-z]\{[^{}]*\}|\\\n)+?\s*=\s*(?:::)?\s*std\s*;", re.S)
NON_ALLOCATING_STD = frozenset((
    # AV 209's own vocabulary -- fixed-width typedefs and the sizes that index them.
    "size_t", "ptrdiff_t", "nullptr_t", "intptr_t", "uintptr_t",
    "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    # Lock-free primitives: an approved C++11 deviation, and the reason rt/ can be
    # SPSC-safe without a mutex.
    "atomic", "atomic_flag", "memory_order",
    "memory_order_relaxed", "memory_order_consume", "memory_order_acquire",
    "memory_order_release", "memory_order_acq_rel", "memory_order_seq_cst",
    # Raw memory. These move bytes into storage the caller already owns.
    "memcpy", "memset", "memmove", "memcmp",
    # Compile-time only -- no runtime object exists to allocate.
    "numeric_limits", "is_same", "enable_if", "declval",
))

class StripError(Exception):
    """An unterminated literal. Raised rather than blanked -- see strip_comments."""


def _char_literal_end(text, i, n):
    """End index of a C++ CHARACTER literal starting at text[i] == "'", or None.

    None means the apostrophe is not opening a char literal at all -- overwhelmingly
    a C++14 DIGIT SEPARATOR (48'000u), which is idiomatic in exactly the audio
    constants this directory is full of.

    THIS IS THE FAIL-OPEN THAT MADE THE WHOLE GUARD VACUOUS. Treating every "'" as a
    literal opener meant one separator -- an odd apostrophe -- swallowed the REST OF
    THE FILE into blanks, and the guard then reported it clean. Measured on
    PR #3155: a fixture holding `constexpr std::uint32_t kFrames = 48'000u;` plus a
    throw, a bare int and a std::vector reported "1 rt/ file(s) clean", exit 0;
    with the separator removed the same file reported 5 violations. Found by
    @security-reviewer.

    A real char literal is short and closes on its own line, so scanning a bounded
    window is enough and cannot run away: `'a'`, `'\\n'`, `'\\''`, `'\\x41'`, `'\\0'`.
    """
    j = i + 1
    limit = min(n, i + 8)          # longest plausible: '\x41' plus slack
    while j < limit:
        c = text[j]
        if c == "\n":
            return None
        if c == "\\":
            j += 2
            continue
        if c == "'":
            return j + 1
        j += 1
    return None


def strip_comments(text):
    """Blank out comments and literals, preserving line structure.

    Without this, the word 'int' in a sentence and the word 'try' in 'entry' style
    prose both trip the guard, and a guard that cries wolf gets switched off.

    Fails CLOSED on an unterminated string: blanking to end-of-file is precisely how
    a guard silently stops checking, which is the failure this function used to have
    in a second form."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith("//", i):
            j = text.find("\n", i)
            if j == -1: j = n
            out.append(" " * (j - i)); i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j == -1:
                raise StripError("unterminated /* comment")
            j += 2
            out.append("".join(c if c == "\n" else " " for c in text[i:j])); i = j
        elif text[i] == '"':
            j = i + 1
            while j < n and text[j] != '"':
                if text[j] == "\n":
                    raise StripError("unterminated string literal")
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                raise StripError("unterminated string literal")
            j += 1
            out.append(" " * (j - i)); i = j
        elif text[i] == "'":
            end = _char_literal_end(text, i, n)
            if end is None:
                # A digit separator or a stray quote. Emit it VERBATIM so the rest
                # of the file is still scanned.
                out.append(text[i]); i += 1
            else:
                out.append(" " * (end - i)); i = end
        else:
            out.append(text[i]); i += 1
    return "".join(out)

violations = []
files = []
for dirpath, _dirs, names in os.walk(rt):
    for name in sorted(names):
        if name.endswith((".h", ".hpp", ".cc", ".cpp", ".mm")):
            files.append(os.path.join(dirpath, name))

for path in files:
    rel = os.path.relpath(path, rt)
    # The decode gets the same fail-closed diagnosis the tokeniser does. It used to
    # sit outside the try and raise a bare UnicodeDecodeError traceback: still exit
    # 1, so never a bypass, but none of the "here is why this file was not scanned"
    # guidance the StripError path is careful to give. That matters more now that
    # the guard's correctness is explicitly Unicode-dependent -- a decode failure is
    # the one way a file reaches these patterns as something other than `str`, which
    # is what makes `\w` and `\b` Unicode-aware in the first place. Found on PR #3188.
    try:
        raw = open(path, encoding="utf-8").read()
    except UnicodeDecodeError as exc:
        print(f"check-native-jsf-profile: rt/{rel}: not valid UTF-8 ({exc}).",
              file=sys.stderr)
        print("  Refusing to report on a file this script cannot decode -- these",
              file=sys.stderr)
        print("  patterns are Unicode-aware only over decoded text.", file=sys.stderr)
        sys.exit(1)
    try:
        code = strip_comments(raw)
    except StripError as exc:
        print(f"check-native-jsf-profile: rt/{rel}: {exc}.", file=sys.stderr)
        print("  Refusing to report on a file this script cannot tokenise -- a",
              file=sys.stderr)
        print("  partial scan reports 'clean' for everything after the problem.",
              file=sys.stderr)
        sys.exit(1)
    # WHOLE-FILE, not line by line. Every call-shaped check writes `\s*` before its
    # `(` to tolerate whitespace, but a per-line scan cannot see whitespace that IS
    # a newline: `return malloc` on one line and `(n);` on the next reported clean,
    # letting an AV 206 allocation through both pre-commit and CI, and the same
    # bypass applied to `free`, the AV 24 process calls, and every other `\s*\(`
    # pattern. Offsets are mapped back to line numbers exactly as the STL and alias
    # checks below already do. Found by Codex on PR #3155.
    #
    # Deduped per (line, rule): a whole-file `finditer` reports every occurrence
    # where the per-line scan reported the first per line, and AV 209 alone would
    # otherwise emit one row per `int` on a declaration-heavy line.
    seen = set()
    for pattern, rule, why in CHECKS:
        for m in re.finditer(pattern, code):
            lineno = code.count("\n", 0, m.start()) + 1
            if (lineno, rule, why) in seen:
                continue
            seen.add((lineno, rule, why))
            violations.append((rel, lineno, rule, why, " ".join(m.group(0).split())))

    # MASK the `= delete` spans, then look at what is LEFT. The old form asked
    # "does this line contain `= delete`?" and skipped the whole line if so -- so
    # one line carrying both an approved deletion and a real one hid the real one.
    # Verified before the fix:
    #   struct C { C() = delete; }; void destroy(C* p) { delete p; }
    # reported clean. Found by Codex on PR #3155.
    #
    # The filler preserves LENGTH and NEWLINES rather than collapsing to two
    # spaces: `=\s*delete` can straddle a line break, and a shorter replacement
    # would shift every offset after it and misreport the line numbers below.
    masked = EQ_DELETE_RE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), code)
    for m in DELETE_RE.finditer(masked):
        lineno = masked.count("\n", 0, m.start()) + 1
        violations.append((rel, lineno, "AV 206", "no free-store deallocation", "delete"))

    # Whole-file, not line-by-line: a `std::` whose name sits on the next line is
    # invisible to a per-line scan. The offset is mapped back to a line number so
    # the report still points at something.
    for m in ALIAS_RE.finditer(code):
        lineno = code.count("\n", 0, m.start()) + 1
        violations.append((rel, lineno, "AV 206",
                           "namespace alias to std reaches the allocating STL under another name",
                           " ".join(m.group(0).split())))
    for m in STD_RE.finditer(code):
        if m.group(1) not in NON_ALLOCATING_STD:
            lineno = code.count("\n", 0, m.start()) + 1
            violations.append((rel, lineno, "AV 206",
                               "std:: name not on the non-allocating allowlist",
                               " ".join(m.group(0).split())))

# Same fail-closed rule one level down: a directory that exists but holds no C++ is
# not a clean tree, it is a tree whose sources moved. Exiting 0 here would report a
# green profile check over zero files.
if not files:
    print(f"check-native-jsf-profile: {rt} contains no C++ sources.", file=sys.stderr)
    print("  The profile check would pass vacuously. Confirm rt/ still holds the",
          file=sys.stderr)
    print("  real-time core, or update the paths here and in native-audio.md.",
          file=sys.stderr)
    sys.exit(1)

if violations:
    print("JSF++ profile violations in concord-audiocap/rt/:")
    print("(the profile is internal-reference; the rationale is ADR-0043 D3)")
    print()
    for rel, lineno, rule, why, tok in violations:
        print(f"  rt/{rel}:{lineno}  {rule}  {why}  — found {tok!r}")
    print()
    print("An AV 206 std:: report means the name is not on this script's")
    print("NON_ALLOCATING_STD allowlist. If it provably does not allocate, add it")
    print("there with the reason; otherwise it does not belong in rt/.")
    print()
    print("If a deviation is genuinely warranted, it goes in the named-deviation")
    print("table in internal-reference AND in ADR-0043 D3 FIRST, then the")
    print("code. In that order — that is the rule the profile states.")
    sys.exit(1)

print(f"check-native-jsf-profile: {len(files)} rt/ file(s) clean.")
PY
