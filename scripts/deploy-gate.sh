#!/bin/bash
# Forced command for the Sapo Reviews deploy key (GitHub Actions).
# Allows exactly two things: rsync into the app directory (rrsync anchors every
# path there) and the deploy script, bound to that same directory.
set -euo pipefail
APP_DIR=/var/www/haravan/Sapo-Server--Reviews
cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  "rsync --server "*)
    exec /usr/bin/rrsync -wo "$APP_DIR"
    ;;
  "deploy $APP_DIR")
    [ -f "$APP_DIR/scripts/remote-deploy.sh" ] || { echo "deploy script missing" >&2; exit 3; }
    exec /bin/bash "$APP_DIR/scripts/remote-deploy.sh"
    ;;
  *)
    echo "command not allowed" >&2
    exit 126
    ;;
esac
