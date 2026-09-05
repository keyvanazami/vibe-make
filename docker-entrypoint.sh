#!/bin/sh
set -e

# Some OpenSCAD builds initialise a GL context even when they're only asked to
# export a mesh, and abort without a display. A throwaway Xvfb makes headless
# rendering work regardless of which build the base image ships.
if command -v Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
fi

exec "$@"
