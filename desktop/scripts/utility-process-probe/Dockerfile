# Headless container for desktop/scripts/utility-process-probe/main.js. Build and run commands
# are in the USAGE block at the top of main.js. Build needs network (apt, npm and the Electron
# binary download); the run needs none.
#
# The base image is pinned by digest (the multi-arch index, so amd64 and arm64 hosts both
# resolve it). Bump the digest on purpose, never by floating the tag.
FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49

# The Electron under test, exact x.y.z. Required: there is deliberately no default, so a probe
# run can never silently measure a version nobody chose.
ARG ELECTRON_VERSION
RUN test -n "${ELECTRON_VERSION}" || { echo "pass --build-arg ELECTRON_VERSION=<x.y.z>" >&2; exit 1; }

# Xvfb for DISPLAY, the Chromium runtime libraries, and util-linux for prlimit (the nproc case).
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libxkbcommon0 libdrm2 libcups2 util-linux \
 && rm -rf /var/lib/apt/lists/*

# Non-root on purpose: RLIMIT_NPROC does not bind root, so the nproc case needs uid 1000 (node).
USER node
WORKDIR /home/node/electron
# Electron 45 ships no postinstall: `npm install` leaves node_modules/electron without its binary,
# which is otherwise fetched on first launch. Fetch it now, at build time, so a run needs no network.
RUN npm install --no-save --no-audit --no-fund "electron@${ELECTRON_VERSION}" \
 && node_modules/.bin/install-electron --no \
 && test -x node_modules/electron/dist/electron

# main.js refuses to run unless this is set, so the probe cannot be launched on a host by accident.
ENV UTILITY_PROCESS_PROBE_CONTAINER=1

# --no-sandbox: an unprivileged container has no user namespaces for Chromium's sandbox. It does
# not change what a utilityProcess fork reports, which is all this probe reads. The probe
# directory is bind-mounted at /probe (read-only) by the run command.
#
# The `sh -c ...; exit $?` wrapper is load-bearing. xvfb-run waits for Xvfb's SIGUSR1, and as
# the container's PID 1 it never gets it: the run hangs silently, before main.js starts, and
# the 60 s backstop inside main.js never arms. With sh as PID 1 and no exec (hence the
# trailing `exit $?`), xvfb-run is an ordinary child and its exit status passes through.
ENTRYPOINT ["sh", "-c", "xvfb-run -a /home/node/electron/node_modules/electron/dist/electron --no-sandbox /probe/main.js; exit $?"]
