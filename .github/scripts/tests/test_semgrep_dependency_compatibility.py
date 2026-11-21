"""Exercise Desktop Semgrep target filtering with the installed candidate lock."""

import json
from importlib.metadata import version
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import certifi


ROOT = Path(__file__).resolve().parents[3]
SEMGREP = Path(sys.executable).parent / "semgrep"


class SemgrepDependencyCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(version("semgrep"), "1.186.0")
        self.assertEqual(version("wcmatch"), "11.2")
        self.temporary = tempfile.TemporaryDirectory(prefix="semgrep-compat-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        # This is intentionally the candidate checkout's ignore file: the
        # compatibility job is read-only and must exercise PR rule *and* ignore
        # configuration before the write-scoped scan consumes the trusted copy.
        shutil.copyfile(ROOT / ".semgrepignore", self.root / ".semgrepignore")
        self.environment = os.environ.copy()
        self.environment["PATH"] = str(SEMGREP.parent) + os.pathsep + os.defpath
        # Keep a Homebrew-installed scanner outside this candidate-lock probe.
        # Semgrep otherwise discovers `pysemgrep` from the host PATH on macOS.
        from semgrep.semgrep_core import SemgrepCore

        self.environment["SEMGREP_CORE"] = str(SemgrepCore.path())
        self.environment["SEMGREP_SEND_METRICS"] = "off"
        self.environment["SEMGREP_LOG_FILE"] = str(self.root / "semgrep.log")
        self.environment.setdefault("SSL_CERT_FILE", certifi.where())
        self.environment["PYTHONSAFEPATH"] = "1"
        self.environment.pop("PYTHONPATH", None)

        sources = {
            "targets/src/window.ts": "const options = { nodeIntegration: true };\n",
            "targets/src/window.test.ts": "const options = { nodeIntegration: true };\n",
            "targets/.hidden/window.ts": "const options = { nodeIntegration: true };\n",
            "targets/scripts/window.ts": "const options = { nodeIntegration: true };\n",
        }
        for relative, contents in sources.items():
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents)

    def scan(self, config, excludes=()):
        args = [
            str(SEMGREP),
            "scan",
            "--config",
            str(config),
            "--json",
            "--quiet",
            "--metrics=off",
            "--disable-version-check",
            "--no-git-ignore",
            "--project-root=.",
        ]
        for pattern in excludes:
            args.extend(["--exclude", pattern])
        args.append("targets")
        result = subprocess.run(
            args,
            cwd=self.root,
            env=self.environment,
            text=True,
            capture_output=True,
            timeout=60,
        )
        self.assertIn(result.returncode, (0, 1), result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["errors"], [])
        return sorted(item["path"] for item in data["results"])

    def test_desktop_electron_rule_excludes_tests_and_matches_production(self):
        self.assertEqual(
            self.scan(ROOT / ".semgrep/concord-electron.yml"),
            ["targets/.hidden/window.ts", "targets/scripts/window.ts", "targets/src/window.ts"],
        )

    def test_cli_exclusion_preserves_unexcluded_desktop_targets(self):
        self.assertEqual(
            self.scan(ROOT / ".semgrep/concord-electron.yml", ("**/scripts/**",)),
            ["targets/.hidden/window.ts", "targets/src/window.ts"],
        )

    def test_target_manager_globs_keep_desktop_path_semantics(self):
        from semgrep.target_manager import TargetManager

        cases = (
            ("desktop/src/window.test.ts", "**/*.test.*", True),
            ("desktop/src/window.ts", "**/*.test.*", False),
            ("desktop/scripts/window.ts", "**/scripts/**", True),
            ("desktop/src/scripts/window.ts", "**/scripts/**", True),
            ("desktop/src/window.ts", "**/scripts/**", False),
            (".hidden/window.ts", "**/*.test.*", False),
        )
        for path, pattern, expected in cases:
            with self.subTest(path=path, pattern=pattern):
                self.assertEqual(TargetManager._globmatch(path, pattern), expected)

    def test_hostile_multistar_pattern_returns_within_limit(self):
        expression = (
            "from wcmatch import glob; "
            "assert not glob.globmatch('uploads/' + '_' * 200, "
            "'uploads/*_*_*_*_*.csv', flags=glob.GLOBSTAR | glob.DOTGLOB)"
        )
        subprocess.run(
            [sys.executable, "-c", expression],
            cwd=self.root,
            env=self.environment,
            check=True,
            timeout=3,
        )


if __name__ == "__main__":
    unittest.main()
