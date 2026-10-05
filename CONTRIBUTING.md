# Contributing

Read the repository's `AGENTS.md` and [the ownership model](docs/architecture.md) first. Normal source changes go through reviewed pull requests. Generated release artifacts are produced by scripts, not edited or committed into `main`.

## Local checks

Use Node 24 LTS, npm, a Rust toolchain capable of building the pinned upstream source, and a C compiler. From the repository root:

```sh
npm ci
npm run generate
npm run build
npm run check
npm run verify:native
npm run smoke:pack
```

Generation downloads pinned source and official release assets, verifies their provenance, and builds a temporary reflection/test program under `build/`. It does not modify an installed Himalaya binary or contact a mailbox. Native differential tests compare serialization with upstream parsing; packed smoke tests exercise the installable JavaScript package.

Report actual commands, results, and gaps. Passing one local platform does not establish cross-platform support or successful email delivery. Tests and CI use synthetic messages, temporary files, and no email credentials.

## Change the owner, not the output

| Change                                 | Source to edit                                                |
| -------------------------------------- | ------------------------------------------------------------- |
| CLI reflection or parser compatibility | `generator/entry.rs`, generation/verification scripts         |
| Generic parameter serialization        | `src/catalog.ts`                                              |
| Execution, file boundaries, lifecycle  | `src/runtime.ts`                                              |
| Factual effect/I/O supplements         | `profiles/himalaya.yaml`                                      |
| User dangerous-operation choices       | The user's external policy; repository provides examples only |
| Publishing/recovery                    | Release scripts and workflows; update the maintenance guide   |

Never hand-edit `build/generated/*`, `dist/*`, generated tool descriptions, or a command registry. Add no email-command handlers, MIME builders, raw-argv fallback, shell tool, or runtime Rust helper. An unfamiliar command remains registered with conservative annotations; it does not create a hidden allowlist or require a dangerous-rule approval to release.

Keep TypeScript strict, changes proportional, and tests focused on meaningful behavior. Preserve native omission/default semantics and fail visibly when syntax cannot be represented. Fix generic incompatibility through the same serializer rather than adding per-command branches.

Agents split substantial independent work by explicit file ownership, inspect each other's results, and run combined checks before delivery. Do not read credentials, send email, alter a NAS service, or edit a user's policy as part of repository maintenance.
