# Desktop Sonar CI Pip dependency analysis warnings — Plan

1. Export the exact Linux CI Pip pins to a CycloneDX SBOM without installing packages; reject unsupported pin syntax and marker expressions.
2. Import the SBOM on main-branch scans, exclude only the two CI manifests from Pip resolution, and remove the global Python opt-out. Preserve the existing exclusions and protected PR SCA boundary.
3. Run focused generator and workflow tests, then follow CI and review gates. After an approved merge, run the main-branch scan and confirm both warnings are gone and the pinned packages are listed.
