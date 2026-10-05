# Security

This adapter executes email operations with the privileges of its process and native Himalaya configuration. A connected trusted client can use registered operations within the instance configuration and file boundaries, except those excluded by an explicitly loaded user policy.

## Boundaries

- There is no arbitrary-shell, raw-argv, arbitrary-host-path or policy-edit adapter tool. The executor uses a fixed binary and an argv array with `shell: false`.
- Server startup owns binary/configuration/policy selection. Declared uploaded files and generated outputs stay in private call workspaces. Account-relative backend paths stay relative to the configured native account root.
- The user owns the dangerous-operation YAML. The example is opt-in and incomplete by design. Unknown commands are executable with conservative effect hints. Native protocol/payload semantics are not automatically analyzed for equivalent destructive actions.
- Tool annotations are static hints, not permissions, human-approval receipts, or prompt-injection protection. A model-supplied confirmation cannot override a deny rule. See [policy behavior](docs/policy.md) and the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Stdio opens no network listener. HTTP defaults to loopback and validates Host/Origin, but supplies no authentication or multi-user authorization. A tunnel or private deployment must restrict access to intended clients. Independent instances require independent credentials, policies, workspaces, and access controls; different URLs or artifact URIs alone do not isolate users.
- Original Himalaya configuration and its credential commands are trusted administrator input. Protect them and the policy outside call workspaces; use read-only deployment mounts where appropriate. This process is not an OS sandbox for upstream code. Opaque MIME/MML/protocol payloads are not parsed for embedded paths or effects; restrict the native process's filesystem and network permissions at deployment.

Mailbox content and attachments are untrusted data. Client agents must not treat email text as instructions or consent to another action. Review the client's handling of writes and disclosure before giving it access.

## Supply chain and logs

Default installation verifies the release archive SHA-256 and extracted executable SHA-256, then checks native version/features against the catalog. Catalog content is bound to the manifest. Digests establish byte identity; they do not prove that upstream code is harmless or that a custom binary was built from the same source.

An explicit `--binary` is administrator-selected. A nonmatching official hash is reported as `verified: false`; version/features and public root Help compatibility are checked locally, not every implementation detail. An incompatible explicit binary fails rather than triggering a fallback download.

Adapter errors and transport logs omit private exception details. Native stdout/stderr are intentionally returned to the authorized caller; upstream debug output is outside this redaction guarantee. Keep credentials and real messages out of issues, fixtures, Git, CI, and captured logs. Write operations are never automatically retried after a timeout or output-limit error because the remote action may already have completed.

## Report a vulnerability

Use the repository's [private vulnerability reporting](https://github.com/samuelncui/himalaya-mcp/security/advisories/new) when available. Report a minimal synthetic reproduction, affected version, and relevant boundary without tokens or private mail. If private reporting is unavailable, open a public issue requesting a private contact without disclosing the exploit or sensitive data. No response-time or supported-version guarantee is currently promised.
