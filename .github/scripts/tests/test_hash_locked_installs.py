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

    def test_ordinary_run_reads_lock_from_pr_base(self):
        run = self.install["run"]
        self.assertIn('git show "${BASELINE_COMMIT}:.github/requirements-semgrep.txt" > "$lock"', run)
        self.assertNotIn('lock=.github/requirements-semgrep.txt', run)

    def test_write_scoped_scan_extracts_trusted_rules_and_ignore(self):
        workflow = (ROOT / ".github/workflows/semgrep.yml").read_text()
        custom = step("semgrep.yml", "semgrep", "Run Semgrep (custom rules)")["run"]

        self.assertIn("git archive", workflow)
        self.assertIn(".semgrep .semgrepignore", workflow)
        self.assertNotIn("--config=.semgrep/", custom)
        self.assertIn('echo "SEMGREP_TRUSTED_RULES=$trusted_dir/.semgrep"', workflow)
        self.assertIn('--config="$SEMGREP_TRUSTED_RULES"', custom)
        self.assertIn('SEMGREP_TRUSTED_IGNORE_NAME', workflow)
        self.assertIn('--x-semgrepignore-filename="$SEMGREP_TRUSTED_IGNORE_NAME"', custom)

    def test_write_scoped_community_and_canary_use_trusted_ignore(self):
        trusted_ignore = '--x-semgrepignore-filename="$SEMGREP_TRUSTED_IGNORE_NAME"'
        for name in ("Run Semgrep (community rulesets)", "Canary — mutable-action-ref detector is still live"):
            with self.subTest(step=name):
                self.assertIn(trusted_ignore, step("semgrep.yml", "semgrep", name)["run"])


class SemgrepCompatibilityWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.steps, self.job = steps("pr-ci.yml", "semgrep-lock-compatibility")

    def test_candidate_lock_job_is_read_only_and_ioc_gated(self):
        self.assertEqual(self.job["needs"], ["ioc"])
        self.assertEqual(self.job["permissions"], {"contents": "read"})
        checkout = next(step for step in self.steps if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["persist-credentials"], "false")

    def test_candidate_lock_job_runs_only_compatibility_test(self):
        commands = "\n".join(step.get("run", "") for step in self.steps)
        self.assertIn("--require-hashes --no-deps --only-binary=:all:", commands)
        self.assertIn("PYTHONSAFEPATH=1", commands)
        self.assertIn("PYTHONPATH=''", commands)
        self.assertIn("python .github/scripts/tests/test_semgrep_dependency_compatibility.py", commands)
        self.assertNotIn("upload-sarif", commands)

    def test_candidate_job_exercises_checked_out_rule_configuration(self):
        commands = "\n".join(step.get("run", "") for step in self.steps)
        compatibility = (ROOT / ".github/scripts/tests/test_semgrep_dependency_compatibility.py").read_text()
        self.assertIn("python .github/scripts/tests/test_semgrep_dependency_compatibility.py", commands)
        self.assertIn(".semgrepignore", commands)
        self.assertIn('ROOT / ".semgrep/concord-electron.yml"', compatibility)
        self.assertIn('shutil.copyfile(ROOT / ".semgrepignore"', compatibility)


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
