#!/usr/bin/env bash
set -euo pipefail

# Load project secrets / local overrides for the pi coding agent.
# This script is used by ``mise run pi`` so the agent can read the same
# environment variables as the rest of the project.

PROJECT_ROOT="${1:-$(pwd)}"

# Prefer the explicitly provided project root, then fall back to the current
# directory.
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$PROJECT_ROOT/.env"
  set +a
elif [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# pi is installed by ``mise install`` into the mise-managed Node global bin.
if ! command -v pi >/dev/null 2>&1; then
  echo "Error: 'pi' is not on PATH." >&2
  echo "Run 'mise install' to install the pi coding agent and its dependencies." >&2
  exit 1
fi
