#!/usr/bin/env bash
set -euo pipefail

# Non-test usage: export a deployer key from your environment.
#   export DEPLOYER_PRIVATE_KEY=...

: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"

STACKS_NETWORK="${STACKS_NETWORK:-devnet}" \
STACKS_API_URL="${STACKS_API_URL:-http://localhost:3999}" \
STACKFLOW_CONTRACT_ID="${STACKFLOW_CONTRACT_ID:-ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.stackflow}" \
npm run init:stackflow
