# Calling the generated CLI tools

Read the common instructions returned during MCP initialization, then use `tools/list` for the tools actually available in this deployment, including native Help and the generated input schema. The initialization instructions own file-channel and uncertain-write guidance independently of automatically exported CLI Help. `himalaya-mcp describe --json` also exposes potential public schemas and the same instructions without executing mail operations; only live tools/list establishes instance availability. Keys under `params` are upstream Clap **argument IDs**, which may differ from flag spelling. Do not infer parameter names or maintain another command registry.

## Structured arguments

```json
{
  "name": "himalaya_account_list",
  "arguments": {
    "request_id": "account-list-example-001",
    "params": { "json": true }
  }
}
```

`params` preserves native scalar, boolean, count, positional, repeated, and grouped-value shapes. It contains ordinary text, JSON, and other native arguments, but **not declared input-file arguments**. File inputs instead use generated top-level fields. The adapter exposes no raw argv or shell interpolation. Native Himalaya remains responsible for business values, account/backend behavior, defaults, and argument conflicts.

The runtime filters the available tools for the current instance: commands wholly denied by user policy and commands declared to require a terminal are not advertised. A conditional policy exclusion is checked against each call. Native Help remains attached to available tools, but its CLI file-path, pipe, and terminal examples are **not MCP input APIs**. Account configuration and authorization must already be complete through the native CLI.

## Durable operation receipts

Every native tool requires a top-level `request_id`: 8–128 letters, digits, underscores, or hyphens. Choose a unique identifier for each intended operation and keep it stable if the same request is checked again. Do not derive identifiers from secrets or message text. Object-key order does not affect the input fingerprint; array order does. Reusing an identifier with changed parameters, another tool, or refreshed file URLs is rejected rather than executing another operation.

The server persists a receipt before accepting native execution and persists `executing` immediately before launching Himalaya. It waits up to approximately two seconds for completion, then returns a receipt while a slow operation continues independently of that request's response. It does not save or replay inputs. An interrupted response therefore has two recovery paths:

- If the receipt was received, call `himalaya_mcp_operation_status` with its `operation.id`.
- If the initial response containing the ID was lost, query directly with the original `request_id`. No native inputs or file URLs are needed, and querying never executes the operation. Use `himalaya_mcp_operations_list` to identify a recent operation by tool and time only when both identifiers are unavailable.

Status accepts **exactly one** of `id` (the returned 64-character lowercase hexadecimal operation ID) or the original `request_id` with the same 8–128-character rules. The server derives the operation ID from the request ID without storing it in plaintext. Both tracking tools are read-only; the listing tool takes no arguments.

Prefer metadata-only completion checks, especially when native output may be large:

```json
{
  "name": "himalaya_mcp_operation_status",
  "arguments": { "request_id": "compose-photo-example-001", "include_result": false }
}
```

`include_result` defaults to `true`, preserving the original status response with any retained native output. When false, the response contains only `operation` and `summary`; it does not include `result` or imply missing output through `resultUnavailable`. Explicitly request output when needed. An identical native request still retrieves the retained operation rather than executing again, but status lookup avoids resubmitting its inputs.

| State          | What is known                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `accepted`     | A durable receipt exists; native execution has not yet been acknowledged                             |
| `executing`    | The durable execution barrier passed; native completion is pending                                   |
| `succeeded`    | Himalaya returned exit code 0; for sending this means backend acceptance, **not recipient delivery** |
| `not_executed` | Native execution did not start, for example because input validation failed                          |
| `unknown`      | Execution or its final durable receipt is uncertain; the remote action may have completed            |

Each receipt response includes a plain-language `summary`. `accepted`, `executing`, and `unknown` do not mean a send failed. Never automatically submit a new request or resend after uncertainty. Use read-only mailbox checks to reconcile the intended recipients, subject, time, and attachments. Missing or expired history is also **not evidence that the original operation failed**.

Deduplication lasts only while the receipt is retained. Metadata is retained for up to 24 hours, with a maximum of 128 records; the oldest terminal records may be evicted sooner at capacity. Active records are not evicted to make space. A full history containing only active operations rejects new work before execution. Do not reuse a previous operation's `request_id` as a new-send strategy after history expires.

Only metadata is persisted: operation ID, tool, state, timestamps, input hash, and safe error/exit summaries. Native inputs, file URLs, message bodies, and full output are not written into history. Complete native output is held only in this process, for at most one hour, eight results, and 64 MiB total. A receipt remains queryable when output is evicted or lost on restart; when output is requested, `resultUnavailable` explicitly explains that absence.

Use `--operation-dir` for private persistent receipt metadata, separate from disposable call workspaces and credentials. One directory has exactly one live server owner. A diagnostic or another user instance must use its own operation directory. Owner metadata includes a process nonce and, on Linux, the boot/PID-namespace identity. A changed Linux scope or a reused current PID with an old nonce identifies a previous runtime; other live or unverifiable owners are refused. Legacy owner files without these identities require a confirmed dead PID. After an identified previous runtime, abandoned `accepted`/`executing` receipts become `unknown` and **are never replayed**. Stale-owner recovery uses an exclusive guard; an orphan recovery guard requires operator inspection after stopping all owners, rather than automatic removal. Graceful server shutdown closes native execution, settles its receipts, and then releases ownership. A request response ending is distinct from shutting down the server.

## One automatic file input route

Each declared input-file argument has a top-level field with that exact native argument ID. A scalar accepts one client file object; a repeated input-file argument accepts an array. A raw string-or-file message accepts one complete file object even when its internal CLI argument is an array. These shapes come from the generated CLI catalog and factual I/O roles; no per-email handler is required. MCP `_meta["openai/fileParams"]` identifies those fields for compatible clients.

A file object has:

| Field          | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `file_id`      | Required client file identifier                                              |
| `download_url` | Required temporary public HTTPS URL for that file's complete original bytes  |
| `file_name`    | Optional original basename; supply it to preserve the filename and extension |
| `mime_type`    | Optional client-declared MIME type; metadata, not proof of contents          |

The client supplies the file reference. The runtime downloads the complete file into a private call workspace, binds its local path to the native argument, and invokes the original Himalaya binary. The model must not fetch file lines, reconstruct MIME, encode attachment bytes in arguments, or split a file into chunks. This remains structured parameter binding; native argv is an internal execution detail.

This compose example uses the generated `attach` array. The identifier and URL are placeholders supplied by a compatible client, not values to invent:

```json
{
  "name": "himalaya_message_compose",
  "arguments": {
    "request_id": "compose-photo-example-001",
    "params": {
      "account_name": "configured-account",
      "to": ["recipient@example.com"],
      "subject": "Photo",
      "body": "Attached is the original photo.",
      "send": true
    },
    "attach": [
      {
        "file_id": "file-photo",
        "download_url": "https://files.example.invalid/temporary-download",
        "file_name": "photo.jpeg",
        "mime_type": "image/jpeg"
      }
    ]
  }
}
```

`params.attach` is not accepted. Scalar file arguments such as `body_file` and `signature_file` use one object rather than an array. These remain native text-file inputs and do not become attachments merely because a file was supplied. Repeated file references preserve native occurrence order.

For commands that accept complete raw mail, supply a single `.eml` object in the generated `message-raw` field. Import the whole file once; preserve the existing MIME structure and attachments. Inline raw mail, shared base64 uploads, `stdin`, and `stdinBase64` have been removed from the public input interface. Other structured text or JSON parameters remain available according to the generated schema.

A file ID alone, an arbitrary host path, a ChatGPT `/mnt/data/...` path, or an output resource URI is not an input reference. The server cannot resolve an opaque client ID without its download URL or read the client's filesystem. If the client does not supply the required file reference, report a **client file-channel limitation immediately**. Do not try alternate encodings, workspace transfers, or a send without the intended attachments.

The metadata and adapter implementation enable this route; they do not by themselves establish that a particular ChatGPT connection forwards files successfully. Check the refreshed live schema and verify a real client file call before claiming end-to-end acceptance. Reattaching a file does not repair a client that lacks the required channel.

## Download and execution boundaries

Downloads accept public HTTPS destinations on the default port only, without URL credentials or fragments. Private, loopback, link-local, and other non-public destinations are rejected. DNS destinations are checked and pinned for each request; redirects are rechecked, with at most three redirects. All file downloads in one call share a 30-second deadline, including DNS resolution, redirects, and body transfer. Temporary links must still be valid at call time. URL queries are used for fetching and excluded from adapter errors and logs.

A supplied filename must be a basename. Without `file_name`, the runtime uses `file_id` as the filename. The transport preserves downloaded bytes; original Himalaya may parse or normalize them. A client MIME label does not override native MIME handling. Backend limits remain authoritative.

Sending and modifications still require the user's intended recipient and content. File transport and operation annotations do not grant consent. A missing, interrupted, or timed-out write result does not establish failure: the operation may already have affected the remote mailbox. Never retry a write automatically after an uncertain result. For a mail send, check Sent against the intended recipients, subject, sending time, and attachments before deciding whether another send is needed. Verify native date-query boundaries and choose conditions that include the intended day; do not assume that `after` includes its boundary date. This document does not assign unverified date semantics to Himalaya.

Output arguments select paths inside the current call workspace; an omitted declared output directory is bound there. Account-relative paths retain their separate native meaning beneath the configured account root. Native configuration is selected by server `--config`, not by a tool argument. This file boundary is not an operating-system sandbox; deployments still own process isolation and credentials.

## Results and output resources

A native call returns an operation envelope. When completion and output are available, `result` preserves native status and captured output:

```json
{
  "operation": {
    "id": "<returned 64-character operation ID>",
    "tool": "himalaya_message_compose",
    "state": "succeeded",
    "createdAt": "2026-10-05T00:00:00.000Z",
    "updatedAt": "2026-10-05T00:00:01.000Z",
    "inputSha256": "<input fingerprint>",
    "exitCode": 0
  },
  "summary": "Native execution exited 0. For sending, this confirms backend acceptance, not delivery to the recipient.",
  "result": {
    "exitCode": 0,
    "stdout": "native output",
    "stderr": "",
    "files": []
  }
}
```

Pending responses contain the receipt without a result. Terminal metadata does not promise that full output is still retained; read `resultUnavailable` when present. Non-UTF-8 native stdout uses `result.stdoutBase64`; it is an output representation, not a file input channel. A timeout can have `exitCode: null` and `timedOut: true`, and remains `unknown` after execution started. A successful status query reports what is known; it does not turn an uncertain operation into success.

Generated files appear in `files` with name, resource URI, MIME type, and size. Names are workspace-relative and use `/` separators on every platform. MCP `resources/list` and `resources/read` retrieve registered outputs. They do not grant arbitrary filesystem access or make a resource URI an automatic input for another call. The public adapter promises no workspace-to-workspace transfer.

Imported files are deleted when native execution finishes; calls without output files retain no call directory. Output resources expire after one hour and belong to this process. A sweep runs every minute, with additional cleanup on calls/resource reads or shutdown. Restarting or closing the server invalidates resources. Retrieve results you need to keep. A killed process or power loss cannot execute cleanup: deployments must use disposable workspace storage or provide crash cleanup, separate from persistent credentials and mail data.

| Boundary                                   | Current limit                           |
| ------------------------------------------ | --------------------------------------- |
| MCP input message/body                     | 64 MiB                                  |
| Downloaded input files together            | 32 MiB per call                         |
| Captured native stdout and stderr together | 32 MiB per call                         |
| One output file                            | 32 MiB                                  |
| Retained artifacts                         | 64 MiB per process                      |
| Simultaneous native calls                  | 4                                       |
| Native execution timeout                   | 120 seconds by default                  |
| All file downloads in one call             | 30 seconds, including DNS and redirects |

Limit failures report an error rather than silent truncation. Clients and native backends can impose smaller limits.

## Process lifecycle

Stdio EOF and SIGINT/SIGTERM close the connection and clean native calls/workspaces. HTTP uses SIGINT/SIGTERM; closed stdin does not stop a background HTTP service. The MCP transport's process stdin is distinct from mail input; it carries protocol messages, not file bytes.

Use `--cache-dir` for downloaded binaries, `--workspace-dir` for temporary call workspaces, and `--policy` only for your chosen exclusions. Protect native configuration, credentials, and policy outside the call workspace. [Security](../SECURITY.md) defines the deployment trust boundary.

On Windows, put `--config` and `--workspace-dir` on the same drive. The adapter uses a relative configuration path to preserve the native CLI's `:` delimiter; a configuration filename containing that delimiter cannot be represented and produces `config_binding`.
