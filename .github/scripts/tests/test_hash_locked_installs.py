"""Hash-locked pip installs read their lock from protected source when the scan is protected."""

from pathlib import Path
import os
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
        self.assertLess(run.index('grep -Eq "^semgrep=='), run.index('else\n'))

    def test_version_upgrade_uses_base_lock_only_for_ordinary_scan(self):
        run = self.install["run"]
        select_lock = run[run.index('lock="$RUNNER_TEMP/requirements-semgrep.txt"'):
                          run.index('# Rule paths and ignore globs')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github").mkdir()
            lock = root / ".github/requirements-semgrep.txt"
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            commits = []
            for pin in ("1.185.0", "1.186.0"):
                lock.write_text(f"semgrep=={pin} \\\n")
                subprocess.run(["git", "add", "."], cwd=root, check=True)
                subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                "commit", "-qm", pin], cwd=root, check=True)
                commits.append(subprocess.check_output(["git", "rev-parse", "HEAD"],
                                                cwd=root, text=True).strip())
            env = os.environ | {"RUNNER_TEMP": directory, "BASELINE_COMMIT": commits[0],
                                "WORKFLOW_SHA": commits[1], "WORKFLOW_REPOSITORY": "Concord-Voice/Desktop",
                                "SEMGREP_VERSION": "1.186.0", "EXTERNAL_VERDICT": "false"}
            result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + select_lock],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("semgrep==1.185.0", (root / "requirements-semgrep.txt").read_text())
            env["EXTERNAL_VERDICT"] = "true"
            result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + select_lock],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("semgrep==1.186.0", (root / "requirements-semgrep.txt").read_text())

    def test_write_scoped_scan_extracts_trusted_rules_and_ignore(self):
        workflow = (ROOT / ".github/workflows/semgrep.yml").read_text()
        custom = step("semgrep.yml", "semgrep", "Run Semgrep (custom rules)")["run"]

        self.assertIn("git archive", workflow)
        self.assertIn(".semgrep .semgrepignore", workflow)
        self.assertIn('rm -rf -- .semgrep', workflow)
        self.assertIn('cp -R "$trusted_dir/.semgrep" .semgrep', workflow)
        self.assertIn("--config=.semgrep/", custom)
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
    def test_trusted_scan_reads_lock_from_protected_policy(self):
        all_steps, _ = steps("ioc-scanning.yml", "supply-chain-scan")
        install = next(s for s in all_steps if "PYYAML_REQUIREMENTS" in s.get("env", {}))
        self.assertEqual(install["env"]["PYYAML_REQUIREMENTS"],
                         "${{ inputs.trusted-source && 'scanner/.github/requirements-pyyaml.txt'"
                         " || '.github/requirements-pyyaml.txt' }}")
        self.assertIn('--require-hashes --only-binary=:all: -r "$PYYAML_REQUIREMENTS"', install["run"])


    def test_protected_ioc_policy_comes_from_the_workflow_revision_on_main(self):
        policy = step("ioc-scanning.yml", "supply-chain-scan", "Materialize the protected scanner and policy")
        self.assertEqual(policy["if"], "${{ inputs.trusted-source }}")
        self.assertEqual(policy["env"]["WORKFLOW_SHA"], "${{ fromJSON(toJSON(job)).workflow_sha }}")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()

            def git(*args):
                return subprocess.check_output(
                    ["git", "-c", "core.hooksPath=/dev/null", *args], cwd=target, text=True, stderr=subprocess.PIPE,
                ).strip()

            git("init", "-q")
            git("config", "user.name", "Workflow test")
            git("config", "user.email", "workflow@example.invalid")
            git("config", "commit.gpgsign", "false")
            lock = target / ".github/requirements-pyyaml.txt"
            scanner = target / "scripts/security/scanner.sh"
            lock.parent.mkdir()
            scanner.parent.mkdir(parents=True)
            lock.write_text("protected lock")
            scanner.write_text("protected scanner")
            git("add", ".")
            git("commit", "-qm", "Protected workflow revision")
            protected = git("rev-parse", "HEAD")
            git("update-ref", "refs/remotes/origin/main", protected)

            lock.write_text("candidate lock")
            scanner.write_text("candidate scanner")
            git("commit", "-qam", "PR content")
            candidate = git("rev-parse", "HEAD")

            cases = (
                ("pull_request", "Concord-Voice/Desktop", candidate),
                ("schedule", "Concord-Voice/Desktop", protected),
                ("workflow_dispatch", "Concord-Voice/Desktop", protected),
                ("pull_request", "other/Desktop", protected),
                ("pull_request", "Concord-Voice/Desktop", "main"),
                ("pull_request", "Concord-Voice/Desktop", protected),
            )
            for event, repo, sha in cases:
                with self.subTest(event=event, repo=repo, sha=sha):
                    result = subprocess.run(
                        ["bash", "-c", policy["run"]], cwd=root, text=True, capture_output=True,
                        env={**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_REPOSITORY": "Concord-Voice/Desktop",
                             "WORKFLOW_REPOSITORY": repo, "WORKFLOW_SHA": sha},
                    )
                    expected = event == "pull_request" and repo == "Concord-Voice/Desktop" and sha == protected
                    self.assertEqual(result.returncode == 0, expected, result.stderr)
                    if expected:
                        self.assertEqual((root / "scanner/.github/requirements-pyyaml.txt").read_text(), "protected lock")
                        self.assertEqual((root / "scanner/scripts/security/scanner.sh").read_text(), "protected scanner")
                    else:
                        self.assertFalse((root / "scanner").exists())


if __name__ == "__main__":
    unittest.main()
