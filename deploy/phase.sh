#!/bin/sh
set -eu
if [ -f /run/secrets/phase_service_token ]; then
  export PHASE_SERVICE_TOKEN="$(cat /run/secrets/phase_service_token)"
fi
case "${1:-start}" in
  dev) command='npm run dev' ;;
  start) command='node --env-file-if-exists=.env .output/server/index.mjs' ;;
  migrate) command='node node_modules/prisma/build/index.js migrate deploy' ;;
  *) echo 'Usage: phase.sh dev|start|migrate' >&2; exit 64 ;;
esac
exec phase run --app "${PHASE_APP:-gains}" --env "${PHASE_ENV:-development}" "$command"
