# Git LFS Hub — admin

[![CI][ci-badge]][gh-wf-href]
[![Coverage][coverage-badge]][coverage-href]
[![CodeQL][codeql-badge]][codeql-href]
[![Socket][socket-badge]][socket-href]
[![License][license-badge]][license-href]

The GC admin worker for [Git LFS Hub](https://github.com/git-lfs-hub) — a [HonoX](https://github.com/honojs/honox) app running on Cloudflare Workers that tracks repository state, lets org admins soft-delete repos (causing the LFS server to return 404), and purges orphaned R2 objects after a grace period. Admins can undelete a repo at any time before purge completes.

For the bigger picture (what the stack does, the [git-lfs-hub/deploy](https://github.com/git-lfs-hub/deploy) flow, the other repos) see the [org overview](https://github.com/git-lfs-hub).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md)

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md)

[ci-badge]: https://badgen.net/github/checks/git-lfs-hub/admin/main?icon=vitest&label=CI
[gh-wf-href]: https://github.com/git-lfs-hub/admin/actions/workflows/main.yml?query=branch%3Amain
[coverage-badge]: https://badgen.net/https/git-lfs-hub.github.io/admin/coverage-badge.json?icon=vitest
[coverage-href]: https://git-lfs-hub.github.io/gc/lcov-report/
[codeql-badge]: https://github.com/git-lfs-hub/admin/actions/workflows/github-code-scanning/codeql/badge.svg
[codeql-href]: https://github.com/git-lfs-hub/admin/actions/workflows/github-code-scanning/codeql?query=branch%3Amain
[socket-badge]: https://badgen.net/static/Socket/report/blue?icon=socket
[socket-href]: https://socket.dev/dashboard/org/git-lfs-hub/repo/@git-lfs-hub/admin
[license-badge]: https://badgen.net/github/license/git-lfs-hub/admin
[license-href]: LICENSE.md
