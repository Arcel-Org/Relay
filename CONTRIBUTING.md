# Contributing

Thanks for taking the time. Relay is open source — issues, PRs, and
reviews are all welcome.

## Ground rules

- **Security bug?** See [SECURITY.md](SECURITY.md) — report privately, don't
  file a public issue.
- **One logical change per PR.** It keeps history readable and review honest.
- **Tests are not optional** for changes to `lib/`, `server/`, or any API
  route. The suite is `vitest`; run it before pushing.
- **Preserve the threat model.** Relay's design assumes the server is *not*
  trusted. A change that moves trust server-side, adds telemetry, or weakens
  the "no server-side logging" property will be rejected even if it's a
  convenient feature.

## Setting up

```bash
npm install
npm run dev            # relay (:8080) + Next.js (:3000)
npm run lint           # eslint — 0 errors required
npm test               # vitest
npm run build          # production app build
npm run build:relay    # production relay (server) build
```

CI runs lint, type-check (app + server), `npm audit --omit=dev`,
the unit tests, and both production builds on every PR.

## What to work on

Feature gaps are tracked in [FEATURES.md](FEATURES.md). The "Known Gaps"
section of the README lists smaller, well-scoped items. If you want to pick
up something bigger, open an issue first so we can agree on the approach
before you write a lot of code.

## Commit style

- Imperative subject line (`fix:`, `feat:`, `test:`, `docs:` prefixes are
  conventional here).
- Reference the issue/PR if there is one.
- Keep the diff focused; separate refactors from behaviour changes.

## License

By contributing you agree that your contributions are licensed under the
same terms as the file they touch (MIT for the client, AGPL-3.0 for
`server/` — see the README's License section).
