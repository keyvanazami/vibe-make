# syntax=docker/dockerfile:1
#
# vibe-make runs three toolchains in one process tree:
#   - Node/Next.js       serves the app and the API routes
#   - openscad (binary)  renders the .scad source to a mesh
#   - python + OCP       converts that mesh to a STEP B-rep solid
#
# That's why this is a container rather than a serverless function.
#
# Every stage sits on Ubuntu 22.04 rather than the node:* Debian images. The
# upstream OpenSCAD snapshot is a *thin* AppImage: it bundles almost nothing
# and links against the host's Qt5, boost 1.74 and libpython3.10 — a set that
# matches Ubuntu 22.04 and that Debian bookworm cannot satisfy (it ships
# python3.11). Keeping the build stages on the same base also means the app is
# built and run against one glibc.

# ---- base: Ubuntu + Node 22 ----
FROM ubuntu:22.04 AS node-base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# ---- deps: node_modules only, so the layer caches on lockfile changes ----
FROM node-base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM node-base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner ----
FROM node-base AS runner
WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive

# Pinned deliberately: snapshot builds rotate out of the archive within months,
# so an unpinned URL turns into a 404 on some future rebuild.
ARG OPENSCAD_SNAPSHOT=2026.01.02.ai30348

# Two groups here: xvfb plus the X/GL stack, and the libraries the thin
# AppImage expects to find on the host. The list was derived by running ldd
# against the extracted binary — not guessed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb python3 python3-venv \
      libgl1 libglu1-mesa libegl1 libfontconfig1 libfreetype6 libglib2.0-0 \
      libdbus-1-3 libx11-6 libxext6 libxrender1 libxi6 libxfixes3 libxcursor1 \
      libxrandr2 libxinerama1 libxkbcommon0 libxkbcommon-x11-0 libxcb1 \
      libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render0 \
      libxcb-render-util0 libxcb-shape0 libxcb-shm0 libxcb-sync1 libxcb-xfixes0 \
      libxcb-xinerama0 libxcb-xkb1 libsm6 libice6 \
      lib3mf1 libqt5core5a libqt5dbus5 libqt5gui5 libqt5multimedia5 \
      libqt5network5 libqt5widgets5 libqscintilla2-qt5-15 \
      libboost-program-options1.74.0 libboost-regex1.74.0 libcairo2 \
      libdouble-conversion3 libharfbuzz0b libmpfr6 libpython3.10 libtbb12 libzip4 \
 && rm -rf /var/lib/apt/lists/*

# Debian/Ubuntu's own openscad package is 2021.01: no .obj export, and four
# years behind the language the model generates against. We unpack the upstream
# snapshot instead. The squashfs payload is read at its computed ELF offset
# rather than via --appimage-extract, so nothing has to execute at build time
# (which also keeps cross-architecture builds working).
RUN apt-get update && apt-get install -y --no-install-recommends squashfs-tools binutils \
 && curl -fsSL -o /tmp/openscad.AppImage \
      "https://files.openscad.org/snapshots/OpenSCAD-${OPENSCAD_SNAPSHOT}-x86_64.AppImage" \
 && OFFSET=$(readelf -h /tmp/openscad.AppImage | awk '\
      /Start of section headers/ {sh=$5} \
      /Size of section headers/  {es=$5} \
      /Number of section headers/{n=$5} \
      END{print sh + es*n}') \
 && unsquashfs -q -o "$OFFSET" -d /opt/openscad /tmp/openscad.AppImage \
 && rm /tmp/openscad.AppImage \
 && apt-get purge -y squashfs-tools binutils && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# OCP (OpenCASCADE bindings) lives in its own venv rather than fighting the
# distro's managed python. PYTHON_BIN points the app at it.
ENV PYTHON_BIN=/opt/venv/bin/python
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OPENSCAD_BIN=/opt/openscad/AppRun \
    HOSTNAME=0.0.0.0 \
    PORT=8080

# The container filesystem is ephemeral, so request logs go to /tmp.
ENV VIBE_LOG_DIR=/tmp/vibe-make

# Next's standalone output ships its own minimal server.js + traced deps.
# scripts/ is copied explicitly: the tracer can't see files we spawn by path.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/scripts ./scripts

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
