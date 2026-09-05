# syntax=docker/dockerfile:1
#
# vibe-make runs three toolchains in one process tree:
#   - Node/Next.js       serves the app and the API routes
#   - openscad (binary)  renders the .scad source to a mesh
#   - python + OCP       converts that mesh to a STEP B-rep solid
#
# That's why this is a container rather than a serverless function.

# ---- deps: node_modules only, so the layer caches on lockfile changes ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app

# Debian's newest openscad is 2021.01, which predates .obj export and four
# years of language features the model happily emits. We install an upstream
# snapshot instead, so the container matches a modern dev install.
# Pinned deliberately: snapshot builds rotate out of the archive.
ARG OPENSCAD_SNAPSHOT=2026.01.02.ai30348

# xvfb backs the virtual display OpenSCAD opens even for headless mesh export.
# The rest are the X/GL/Qt libraries the AppImage expects from the host.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      python3 \
      python3-venv \
      ca-certificates \
      curl \
      libgl1 libglu1-mesa libglx-mesa0 \
      libfontconfig1 libfreetype6 libglib2.0-0 libdbus-1-3 \
      libx11-6 libxext6 libxrender1 libxi6 libxfixes3 libxcursor1 \
      libxrandr2 libxinerama1 libxkbcommon0 libxkbcommon-x11-0 \
      libxcb1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 \
      libxcb-render0 libxcb-render-util0 libxcb-shape0 libxcb-shm0 \
      libxcb-sync1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 libsm6 libice6 \
 && rm -rf /var/lib/apt/lists/*

# --appimage-extract unpacks without FUSE, which isn't available in a build
# container. AppRun sets up the bundle's own library paths before exec'ing.
RUN curl -fsSL -o /tmp/openscad.AppImage \
      "https://files.openscad.org/snapshots/OpenSCAD-${OPENSCAD_SNAPSHOT}-x86_64.AppImage" \
 && chmod +x /tmp/openscad.AppImage \
 && cd /opt && /tmp/openscad.AppImage --appimage-extract > /dev/null \
 && mv /opt/squashfs-root /opt/openscad \
 && rm /tmp/openscad.AppImage

# OCP (OpenCASCADE bindings) lives in its own venv rather than fighting
# Debian's PEP-668 managed environment. PYTHON_BIN points the app at it.
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
