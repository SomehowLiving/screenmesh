# Contributing to ScreenMesh

Thanks for considering a contribution. ScreenMesh is a security-sensitive product, but it should also stay pleasant to use. A good contribution improves one without quietly weakening the other.

## Before you start

Read the [README](README.md), [FAQ](FAQ.md), [product idea](IDEA.md), and the relevant document under `docs/`. Small, focused changes are easier to review and safer to test than a broad rewrite.

For a feature that changes product behavior, open an issue first. This helps us agree on the user problem before investing in implementation details.

Do **not** open a public issue for a suspected security vulnerability. Follow [SECURITY.md](SECURITY.md) instead.

## Local setup

You need Node.js 20+ and pnpm 9+.

```bash
pnpm install
pnpm typecheck
pnpm dev:server
pnpm dev:web
```

To simulate a second web device, open the web app with `?device=2` in another browser window.

## What a good pull request looks like

- Explain the user problem and the intended behavior.
- Keep unrelated refactors out of the change.
- Preserve the local-first and end-to-end encryption boundaries.
- Update relevant docs when a product or protocol behavior changes.
- Add or update tests where practical.
- Run the checks below before requesting review.

```bash
pnpm typecheck
pnpm smoke
pnpm --filter @screenmesh/web build
```

## Design principles

- Put objects and useful work ahead of networking detail.
- Keep routing understandable: delivered, queued safely, waiting, or needs approval.
- Never silently change an explicitly chosen recipient.
- Use progressive disclosure for transport and security detail.
- Do not add a permission-looking UI control unless the protocol actually enforces it.
- Prefer clear language over unexplained protocol jargon.

## Security and privacy rules

Never include any of the following in an issue, pull request, screenshot, test fixture, or commit:

- Pairing QR codes or join links
- Workspace keys, private keys, ratchet/session state, or auth tokens
- Real plaintext object contents from someone else
- Personally identifying network addresses without permission

Use synthetic device names and test payloads. Treat every paired device as potentially holding sensitive personal work.

## Code and documentation

- Match the existing TypeScript style and package boundaries.
- Keep protocol changes compatible across web, agent, and Android clients—or clearly document what is intentionally deferred.
- Prefer explicit product limitations over claims the implementation cannot support.
- Use Mermaid diagrams only when they make a relationship clearer than a short paragraph.

## License

By submitting a contribution, you agree that it is licensed under the [Apache License 2.0](LICENSE).
