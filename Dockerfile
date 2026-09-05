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

# openscad pulls in the GL/X libraries it needs; xvfb backs the virtual display
# some OpenSCAD builds still open even for headless mesh export.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openscad \
      xvfb \
      python3 \
      python3-venv \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# OCP (OpenCASCADE bindings) lives in its own venv rather than fighting
# Debian's PEP-668 managed environment. PYTHON_BIN points the app at it.
ENV PYTHON_BIN=/opt/venv/bin/python
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OPENSCAD_BIN=openscad \
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
