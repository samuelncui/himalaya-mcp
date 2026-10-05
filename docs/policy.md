# User-owned dangerous-operation policy

The generated catalog retains every runnable native command. An instance exposes those with usable backend/terminal requirements; whole-command exclusions are omitted from tools/list and blocked on direct calls. Conditional exclusions remain advertised because permitted calls still exist. `--policy /absolute/path/to/policy.yaml` loads only the external YAML that the user selects. Repository examples are neither an exhaustive danger catalog nor a default policy.

A small example:

```yaml
schemaVersion: 1
deny:
  - command: imap expunge
    reason: Permanently removes messages already marked Deleted.
  - command: gmail messages delete
    reason: Permanently deletes a Gmail message instead of moving it to Trash.
```

The example corresponds to [IMAP EXPUNGE](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4.3) and [Gmail messages.delete](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete); provider-specific retention and other entry points still need your review.

Choose each exclusion yourself. A practical minimal criterion is an operation that deletes or overwrites existing user data without a native recovery route. Help words such as "delete" are insufficient: actual backend behavior, API, parameters, and recovery semantics matter. Sending and attachments are allowed by this example; annotations still describe their effects.

Rules match space-separated **canonical command paths**. `*` matches one path segment; `**` matches zero or more. Any matching rule blocks execution before the subprocess runs. Multiple rules are alternatives; fields inside one `when` are all required to match. Policy is reloaded for each call.

```yaml
schemaVersion: 1
deny:
  - command: imap expunge
    reason: My explicit exclusion for this operation.
    when:
      mailbox_no_select: true
```

That example illustrates matching a generated boolean ID, not a recommendation to approve other expunge modes. `when` accepts scalars or arrays of candidate scalar values. Current conditional rules require explicitly supplied, safely normalized boolean/count/integer arguments. If a relevant argument is omitted or depends on opaque native string parsing, execution reports `policy_unresolved`; it does not guess defaults, remote mailbox roles, or API behavior. Conditions compare MCP inputs; they do not interpret hidden native parser transformations. Recheck conditional rules when upgrading. Prefer a command-level rule when native state cannot be established. A mixed reversible/irreversible command may consequently need broader exclusion; that choice belongs to the user.

The policy does not analyze raw IMAP/JMAP/API payloads or discover equivalent actions across other command paths. A rule covering one command cannot guarantee that another protocol entry point lacks the same effect. The user owns those exclusions. Newly discovered commands remain executable when the instance can support them; unknown effects do not revive a project allowlist.

## Approval and annotations are different

`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are static MCP tool annotations. Unclassified commands use conservative write/destructive/non-idempotent hints. These hints do not add a deny rule or prove that a human authorized a particular call. The [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) defines them as hints.

This version has no authenticated, one-call approval channel. A denied operation stays denied even if an agent submits a confirmation field or claims that the user approved it. The user must personally change the external policy or execute the intended operation with the original CLI. An edit changes the policy for future matching calls; it is not a one-use authorization receipt.

Keep the file outside MCP workspaces and protect it with host permissions or read-only deployment mounts. The server exposes no policy-edit tool. Other host agents with filesystem permissions remain outside this server's authorization boundary. Upstream release automation neither edits user policy nor waits for project maintainers to approve new dangerous entries.
