# Contributing

English | [中文](CONTRIBUTING.zh.md)

TurboFlux is maintained by its repository owner. We currently do not accept external pull requests; the repository policy workflow closes them automatically. Please use [Issues](https://github.com/MengShengbo/TurboFlux/issues) for reproducible bugs, feature requests, research, and feedback. You can also build plugins, Skills, integrations, and work packs in your own repositories.

## Source and branches

This repository publishes Desktop and the packages and remote-control client it needs. Orbit is not part of this source release. `main` is the only long-lived remote branch. Maintainer verification branches are temporary and are deleted after integration. Dependency upgrades are handled manually; automatic version-update pull requests are disabled.

## Maintainer checks

Use Node.js 22.12 or newer, npm, and ripgrep. Run these commands at the repository root:

```sh
npm ci
npm run ci
```

The local check sequence covers lint, package and application builds, all workspace type checks, package tests, Desktop tests, remote-control tests, and publication and architecture boundaries. Lefthook runs staged lint and whitespace checks before commits, and source checks before pushes. Confirm hooks with `npx lefthook install` if your installation skipped dependency lifecycle scripts.

GitHub Actions also validates Linux and Windows package tests, macOS and Windows Desktop tests, and macOS, Windows, and Linux packaging and acceptance evidence. The required **Quality gate** succeeds only when every dependency job succeeds. Main protection applies to administrators and disallows force pushes and deletion. Before updating `main`, publish a temporary verification branch and run the CI workflow on that exact commit. Advance `main` only after it passes, then delete the verification branch.

The external-PR policy runs from the trusted default branch with permission to close pull requests from forks. It never checks out or executes pull-request code. Issue triage labels incoming reports, and failures are surfaced instead of being silently ignored.

Do not commit credentials, local profiles, generated evidence, build output, or research archives. Platform signing and distribution remain separate from source validation.
