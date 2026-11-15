# Driver Guidelines

Apply these rules for changes under `packages/pi-sdk-driver/`.

- Keep this package a thin SDK adapter over the shared PAO/pi kernel; reuse its session/runtime behavior. Desktop ships the matching kernel and must not require a globally installed CLI or a source-checkout path.
- Preserve event ordering and per-session isolation; desktop parallel sessions must not bleed state across sessions.
- Treat session config as session-local unless `pi` itself defines broader scope.
- Prefer cache-first desktop reopen behavior; raw session-log reprocessing is a fallback, not the default path.
- Don’t pull desktop-only presentation concerns into driver contracts unless they are required for correctness.
