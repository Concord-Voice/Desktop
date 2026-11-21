# Desktop Sonar CI Pip dependency analysis warnings — Design

Issueless ad-hoc lifecycle, 2026-11-21.

SonarCloud reports disabled Pip resolution for `.github/requirements-pyyaml.txt` and `.github/requirements-semgrep.txt` because `sonar.sca.pythonNoResolve=true` is global. These are hash-pinned CI tooling manifests tracked by Dependabot. The Semgrep lock deliberately overrides upstream constraints and is installed with `--no-deps`, so ordinary Pip resolution would fail.

Generate a CycloneDX SBOM from the exact Linux CI pins on main-branch scans without installing packages. Exclude the two manifests from Pip resolution, import the SBOM into SCA, and remove the global Python opt-out. Keep the existing fixture/probe exclusions and protected PR `sonar.sca.enabled=false` override.

Acceptance: the next main-branch SonarCloud scan no longer reports the two Pip errors and lists their pinned packages as SBOM dependencies. Protected PR scanning cannot resolve PR-controlled manifests.
