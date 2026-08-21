# DEV-AI Harness (DSH)

The embedded plugin-configurable harness runtime of the DEV-AI Suite. This
component ships the real DeepSeek Harness runtime — pinned by exact version,
never by npm dist-tag — and composes it through a product profile named
`devai`, using the same layered patch mechanism the `dsh` CLI uses. Because
the embedded harness *is* the pinned runtime, plugins written for the dsh
ecosystem load without modification: the component is compatible with
DeepSeek Harness v0.1.1-rc.2 plugins.

## Layout

| Path | Role |
|---|---|
| `package.json` | Exact-pinned dsh runtime dependencies (`@deepseek-ai/dsh-base` 0.1.1-rc.2 and friends) — the "dsh installation" bundle resolution anchors on |
| `bundle/` | `devai-harness-bundle`: the DEV-AI Suite product overrides as a dsh bundle layer (`dsh.bundle.patch` → `cordis.patch.yml`), stacked over `@deepseek-ai/dsh-base` |
| `src/boot.ts` | Embedded boot: auto-initializes the `devai` profile under the harness home (`$DSH_HOME`, else `~/.dsh`), composes bundle layers + the profile's own `cordis.patch.yml` + caller overlays, and boots via `@deepseek-ai/dsh-app-boot` |
| `test/fixtures/dsh-plugin-greeter/` | Third-party-style dsh tool plugin (npm package shape prescribed by the dsh cordis tutorial), used as the compatibility fixture |
| `test/plugin-load.test.ts` | Acceptance test: packs and installs the fixture into the `devai` profile through the package-manager flow, boots the runtime, and executes the plugin's tool through `ctx.tools` |

## The devai profile

A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
`package.json` (out-of-tree plugin dependencies plus the `dsh.profile`
manifest with its ordered `bundles` list) and the user's own
`cordis.patch.yml`. The tree composes over an empty root: each bundle's patch
in order, then the profile's `cordis.patch.yml`, then caller overlays. An
id-targeted patch replaces the matched row's whole config (no deep-merge).

The `devai` profile stacks:

1. `@deepseek-ai/dsh-base` — the shared dsh core (llm, session, tools, agent,
   sandbox, persistence, …), unmodified.
2. `devai-harness-bundle` — the product layer (`bundle/cordis.patch.yml`):
   telemetry hard-disabled, module-reload HMR off.
3. The user's `profiles/devai/cordis.patch.yml`, then any overlays the
   embedding caller passes (the CLI's `--patch` slot).

Third-party plugins enter by the dsh ecosystem's canonical flow: install the
npm package into the profile directory, then add its entry in the profile's
`cordis.patch.yml` (or an overlay). Plugins written against DeepSeek Harness
v0.1.1-rc.2 load as-is; compatibility with other versions is not promised —
upstream is a developer preview with announced breaking changes, so the pin
only moves together with a green acceptance run.

## Running the acceptance test

```sh
cd devai-harness
npm install
npm test          # or, from the repository root: npm run devai-harness-test
```

The test needs Node `^22.19.0 || >=24` and reaches registry.npmjs.org only
through the component's own `npm install`. It creates a throwaway harness
home under `devai-harness/.tmp-test-home/` (gitignored) and exits 0 only if
the unmodified fixture plugin activates and its tool answers through the
harness pipeline.

## Notes

- This component is deliberately outside the VS Code build graph in Phase 1;
  the IDE-facing bridge (Agent Host integration) is a later phase.
- Third-party notices for the pinned runtime live in the repository's
  `ThirdPartyNotices.txt`; component registrations in `cgmanifest.json`.
- Node engine range and the profile/patch semantics follow the pinned dsh
  runtime's own documentation.
