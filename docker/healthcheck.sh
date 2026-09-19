#!/usr/bin/env bash
# Container healthcheck: the Worker's /health must answer on the public port.
# A deploy job has no listener, so it is always healthy once it exits 0.
set -euo pipefail
port="${PORT:-8080}"
curl -fsS "http://127.0.0.1:${port}/health" >/dev/null
