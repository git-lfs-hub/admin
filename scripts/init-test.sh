#!/bin/bash
set -Eeo pipefail
cd "$(dirname "$0")/.."
root="$(cd .. && pwd)"
bun run "$root/config/src/cli.ts" init-test-worker "$PWD" "$PWD/test/worker"
