# Contributing to Continuum Chat

Thanks for your interest in contributing to Continuum Chat.

We welcome issues, pull requests, bug reports, docs improvements, and feature ideas.

## Before you start

- Read the main [`README.md`](./README.md) for installation, runtime, and release context.
- Keep changes focused. Small, reviewable pull requests are much easier to validate and merge.
- If you are changing behavior, include enough context in the PR description for someone else to understand the why.

## Preferred contribution workflow

This repository is intentionally optimized for agent-assisted development.

Our preference is that implementation commits in a pull request are authored through an AI coding agent workflow when practical (for example, GitHub Copilot CLI or a comparable coding agent), because that usually produces a cleaner, more traceable commit history for this project.

That is a preference, not a hard requirement. Manual contributions are still welcome. If you are contributing without an agent, please keep commits focused, descriptive, and easy to review.

## Commit and PR expectations

- Keep one logical change per commit when possible.
- Use clear commit messages that explain the change, not just the symptom.
- Avoid mixing unrelated refactors with the main fix or feature.
- Include screenshots or short notes for UI changes.
- Mention any follow-up work or known limitations in the PR description.

## Local validation

From the repository root:

```bash
npx pnpm@10.26.1 install
pnpm exec tsc -p apps/client/tsconfig.build.json --noEmit
cargo build --manifest-path apps/daemon/Cargo.toml --bin continuum
node apps/client/scripts/build.mjs
```

If you run the daemon locally as an installed service, restart it after validating:

```bash
continuum daemon service restart
curl -s http://127.0.0.1:4000/api/health
```

## Scope guidance

Good contributions include:

- bug fixes
- UI polish
- daemon reliability improvements
- remote access and install improvements
- documentation updates
- PR/review workflow improvements

Please avoid bundling unrelated cleanup into a single PR.

## Questions and proposals

If you want feedback before building something larger, open an issue first and describe:

- the problem you want to solve
- the proposed approach
- any tradeoffs or compatibility concerns

Thanks again for helping improve Continuum Chat.
