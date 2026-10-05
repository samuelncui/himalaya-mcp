# Architecture and ownership

```text
Pinned upstream source + Cargo.lock + official binary features
  → build-time Clap reflection and parser differential checks
  → catalog + provenance manifest + factual profiles
  → bundled JavaScript npm package
  → MCP request_id/params/file objects → generic serializer → original Himalaya binary
  → durable operation receipt + native status/output + artifact resources
```

## One source for CLI syntax

Himalaya's upstream Clap tree owns command paths, aliases, arguments, arity, flags, choices, native defaults, and Help. `generator/entry.rs` reflects that tree from a temporary source copy with the selected release's locked dependencies and feature set. Its parser mode is development verification tooling only. Neither reflection code nor a modified executable is shipped to users.

The catalog retains the full reflected tree, including framework-generated Help nodes. The generator marks those nodes and derives runnable entries; registration uses that metadata rather than a hand-maintained list. The 2.2.1 baseline catalog currently yields 188 executable entries. Runtime tools/list filters terminal commands, whole-command user exclusions and namespaces with no configured backend; it adds generic operation status/list tools. This is an observed result, not a future count invariant or a command allowlist.

`build/generated/catalog.json` is bound by SHA-256 to `manifest.json`. The manifest records native version, source revision, feature set, platform assets, and both archive/executable digests. `dist/profiles.json` is built from the factual source `profiles/himalaya.yaml`. Generated files are disposable outputs; change their owner and regenerate.

## Runtime modules

| Owner                 | Responsibility                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `src/binary.ts`       | Locate/inspect a selected local binary or install a verified official asset atomically           |
| `src/catalog.ts`      | Derive tools/schema/Help and serialize typed parameters to canonical native argv                 |
| `src/policy.ts`       | Load the explicit user policy and match exclusions before execution                              |
| `src/file-input.ts`   | Import client file bytes over verified public HTTPS with pinned DNS, redirect checks and limits  |
| `src/runtime.ts`      | Shared input validation, file boundaries, native subprocess lifecycle, result/artifact ownership |
| `src/operations.ts`   | Persistent execution receipts, bounded result cache, deduplication and status queries            |
| `src/instructions.ts` | Shared client guidance for files, receipts and Sent verification, independent of native Help     |
| `src/mcp.ts`          | Official SDK protocol and stdio/HTTP transport; no email handlers                                |
| `src/cli.ts`          | Startup configuration, integrity checks, describe/doctor/serve                                   |

Native Himalaya owns account/backend behavior, email formats, OAuth configuration, business values, defaults, and argument conflicts. The serializer validates representable shapes and avoids option rebinding. Ordinary omitted parameters remain omitted so native semantics apply; the serializer does not invent native defaults. The file boundary can bind an omitted output directory to the call workspace, or require an explicit path when a native filesystem default cannot satisfy that boundary.

## Factual supplements and user choices

Profiles supply effects, interactive behavior, I/O roles and factual `pathExpansion` rules that Clap types/Help cannot fully establish. They distinguish literal `PathBuf` fields from the upstream shell-expanding parser, including inherited log paths. Checked shell-expanded paths are escaped before native execution to preserve their exact identity. Profiles merge in order against canonical command patterns. They do not create command definitions. Factual terminal/backend requirements determine instance availability. Unknown effects use conservative write/destructive/non-idempotent annotations while execution remains available.

Annotations cover a tool's permitted modes, including writable file options; a current call's parameters cannot change the static tool definition. They are independent of user exclusions. Sending may carry a destructive hint while remaining allowed by the user's policy.

The external YAML policy belongs to the final user. The project supplies an example only, does not install it automatically, and does not invent or approve dangerous rules during an upstream release. New commands and Help register automatically when generation and technical compatibility checks pass.

## File and deployment ownership

Each call gets a private workspace. Uploaded files and outputs are call-scoped; resources reference registered outputs rather than arbitrary filesystem paths. Native account-relative paths preserve the configured account root. These are different boundaries: changing a logical mailbox path must not silently turn it into a host upload/output path.

Declared `inputFile` and `inlineOrFile` roles also generate top-level file-object fields and OpenAI `fileParams` metadata. The runtime binds these fields to the canonical native parameters and private imports. Policy checks happen before downloads; every download must finish before native execution. No command-specific attachment or MIME handler is involved. Only declared top-level file objects are public input channels; native file fields are removed from params. See [usage](usage.md).

Startup fixes the native configuration and optional policy. The deployment owns account credential helpers, persistent backend storage, authentication, filesystem mounts, process isolation, and access to the tunnel. The adapter does not add a user database, OAuth provider, synchronization daemon, or approval service.

The JavaScript runtime uses the [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). Build-time Rust tooling and development dependencies stay out of the published package. Runtime behavior, package contents, and each platform are verified separately; a source build alone proves none of the deployment properties.

## Interrupted calls

A single long-lived runtime owns each private operation directory. Before spawning native execution, the runtime persists an execution barrier. Calls return a receipt within two seconds and continue in that server process; HTTP client disconnects do not stop them. An operation's stable request ID deduplicates identical calls only while its receipt remains retained. Pending/unknown/missing states never authorize a retry. Metadata persists up to 24 hours/128 records; native output stays only in bounded process memory. Restarted pending records become unknown, not failed. There is no durable input queue or automatic resumption. A native zero exit proves backend acceptance, not recipient delivery. Deployments must keep this owner alive independently of client sessions.
