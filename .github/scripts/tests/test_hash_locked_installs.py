"""Hash-locked pip installs read their lock from protected source when the scan is protected."""

from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[3]


def steps(workflow, job):
    data = yaml.load((ROOT / ".github/workflows" / workflow).read_text(), Loader=yaml.BaseLoader)
    return data["jobs"][job]["steps"], data["jobs"][job]


def step(workflow, job, name):
    all_steps, _ = steps(workflow, job)
    return next(s for s in all_steps if s.get("name") == name)


class SemgrepLockTests(unittest.TestCase):
    def setUp(self):
        _, self.job = steps("semgrep.yml", "semgrep")
        self.install = step("semgrep.yml", "semgrep", "Install Semgrep")

    def test_lock_pins_the_workflow_version(self):
        version = self.job["env"]["SEMGREP_VERSION"]
        lock = (ROOT / ".github/requirements-semgrep.txt").read_text()
        self.assertRegex(lock, rf"(?m)^semgrep=={re.escape(version)} \\$")

    def test_version_check_rejects_near_misses(self):
        run = self.install["run"]
        check = run[run.index("grep -Eq"):run.index("exit 1; }") + len("exit 1; }")]
        with tempfile.TemporaryDirectory() as d:
            for pin, ok in (("1.186.0 \\", True), ("1.186.0", True),
                            ("1.186.01 \\", False), ("1.18 \\", False), ("1x186x0 \\", False)):
                lock = Path(d) / "lock.txt"
                lock.write_text(f"semgrep=={pin}\n")
                res = subprocess.run(["bash", "-c", f"set -euo pipefail; lock={lock}; {check}"],
                                     env={"SEMGREP_VERSION": "1.186.0", "PATH": "/usr/bin:/bin"},
                                     capture_output=True)
                self.assertEqual(res.returncode == 0, ok, pin)

    def test_protected_run_reads_lock_from_workflow_commit(self):
        run = self.install["run"]
        self.assertIn('if [[ "$EXTERNAL_VERDICT" == true ]]; then', run)
        self.assertIn('git show "${WORKFLOW_SHA}:.github/requirements-semgrep.txt" > "$lock"', run)
        self.assertIn('-r "$lock"', run)
        self.assertNotIn("-r .github/requirements-semgrep.txt", run)
        self.assertEqual(self.install["env"]["WORKFLOW_SHA"],
                         "${{ fromJSON(toJSON(job)).workflow_sha }}")
        self.assertEqual(self.job["env"]["EXTERNAL_VERDICT"], "${{ inputs.external-verdict }}")
        self.assertEqual(self.job["env"]["PYTHONSAFEPATH"], "1")


class IocPyyamlLockTests(unittest.TestCase):
    def test_trusted_scan_reads_lock_from_scanner_checkout(self):
        all_steps, _ = steps("ioc-scanning.yml", "supply-chain-scan")
        install = next(s for s in all_steps if "PYYAML_REQUIREMENTS" in s.get("env", {}))
        self.assertEqual(install["env"]["PYYAML_REQUIREMENTS"],
                         "${{ inputs.trusted-source && 'scanner/.github/requirements-pyyaml.txt'"
                         " || '.github/requirements-pyyaml.txt' }}")
        self.assertIn('--require-hashes --only-binary=:all: -r "$PYYAML_REQUIREMENTS"', install["run"])


if __name__ == "__main__":
    unittest.main()
