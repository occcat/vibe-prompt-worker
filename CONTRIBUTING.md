# Contributing

Issues and pull requests are welcome. Coding and commit rules for this repository live in [AGENTS.md](AGENTS.md).

## Before you start

- Search existing [issues](https://github.com/occcat/vibe-prompt-worker/issues) and [discussions](https://github.com/occcat/vibe-prompt-worker/discussions).
- Open a discussion for questions and early ideas. Open an issue when the problem is actionable.
- Do not report security vulnerabilities in public issues. Use the [private advisory form](https://github.com/occcat/vibe-prompt-worker/security/advisories/new). See [SECURITY.md](SECURITY.md).

## Secrets

Do not commit, paste, or screenshot secrets. The never-include list is in [SECURITY.md](SECURITY.md).

`.dev.vars` is gitignored. Copy `.dev.vars.example` for local development and keep the real file off git.

## Development

Requires [Node.js 22](https://nodejs.org/) or newer.

```sh
npm ci
npm test
npx tsc --noEmit
```

`npm start` runs `wrangler dev`. Set `AUTH_VALUE` in `.dev.vars` first.

## Pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/). The subject is one line (`type(scope): summary`). After a blank line, the body must state:

1. What observable behavior changed
2. What must stay the same
3. The exact commands used to verify

Do not expand the change into unrelated refactors. Update README.md and README.zh-CN.md together when operator-facing behavior changes.
