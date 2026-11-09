# Rotation regression checks

Run from this repository with Node 22 or newer:

```sh
node --require ./tests/rotation/block-outbound.cjs --loader ./tests/rotation/loader.mjs --test --test-force-exit ./tests/rotation/*.test.mjs
```

Fixtures use temporary databases and synthetic credentials. The preload blocks non-loopback TCP traffic. Provider adapters mock fetch; `--test-force-exit` closes surviving helper timers after assertions finish. This suite does not exercise paid provider generation or live accounts.

Install the locked test dependencies with `npm ci --prefix tests`, then run `npm run test:rotation --prefix tests`. The UI checks use this repository's own esbuild, jsdom and Testing Library dependencies. Browser geometry and scroll behavior require separate visual acceptance.
