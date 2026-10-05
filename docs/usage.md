# Calling the generated CLI tools

Use `himalaya-mcp describe --json` or MCP `tools/list` for the current tool names, native Help, and input schemas. Keys under `params` are upstream Clap **argument IDs**, which may differ from flag spelling; do not infer `account_name` from `--account` or maintain a second registry.

## Input and result

```json
{
  "name": "himalaya_account_list",
  "arguments": {
    "params": { "json": true }
  }
}
```

`params` preserves native scalar, boolean, count, positional, repeated, and grouped-value shapes from the generated schema. Ordinary absent keys remain absent; declared output-directory destinations are bound to the call workspace when omitted. Native Himalaya checks choices, account names, argument conflicts, and required business values. The adapter provides no raw argv or shell interpolation.

| Shared input  | Meaning                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `stdin`       | UTF-8 text delivered to native stdin                                                                                    |
| `stdinBase64` | Canonical base64 decoded to native stdin bytes; mutually exclusive with `stdin`                                         |
| `files`       | Uploaded `{ "name": "basename", "base64": "..." }` files; reference a name as `file:<name>` in a declared file argument |

The protocol preserves uploaded/stdin transport bytes. Original Himalaya may decode, parse, or normalize them; byte-for-byte identity of an upstream MIME transformation is not promised. For send operations, supply the raw RFC822/MIME or native format that that command's Help requires. The adapter adds no body/recipient/attachment API and performs no MIME construction.

For example, a `himalaya_message_send` call can use `stdin` with a complete message, or upload `message.eml` and set `params["message-raw"]` to `["file:message.eml"]`. Set `account_name` only when selecting a configured account. The same generic mechanism works for complex MIME; sending still requires the user's intended recipient and content.

Successful execution returns this structure as text and structured content:

```json
{
  "exitCode": 0,
  "stdout": "native output",
  "stderr": "",
  "files": []
}
```

Non-UTF-8 stdout uses `stdoutBase64`; native failure or timeout sets MCP `isError`. A timeout may return `exitCode: null` and `timedOut: true`. Do not infer that a remote write failed or retry it automatically.

## Files and resources

Uploaded names must be unique basenames. For declared file arguments, host paths, traversal, escaping symlinks, and output overwrites of uploaded inputs are rejected. Ordinary native `PathBuf` arguments preserve literal filenames, including `$`. The string-or-file message input applies the native shell expansion before checking an existing file, then binds a checked file or materializes inline text privately so the native process cannot reinterpret that decision. `file:<name>` always refers to the literal uploaded name. Opaque payload content remains native behavior; this is not an OS sandbox. Output arguments select paths inside that call's workspace; declared account-relative paths select logical paths beneath the native configured account root. An omitted declared output directory uses the call workspace. Native path defaults that cannot be represented within this file contract require an explicit value. Native configuration is selected by server `--config`, not an MCP parameter.

Generated ordinary files appear in `files` with name, URI, MIME type, and size. Names are workspace-relative and use `/` directory separators on every platform. Use MCP `resources/list` and `resources/read` to retrieve them as base64 blobs. URIs are registered outputs, not arbitrary `file:` URLs. URIs currently expire after one hour and are process-scoped; expired files are reaped on later calls/resource reads or shutdown. Restarting or closing the server invalidates these resources. Download files you need to keep.

| Boundary                                              | Current limit                         |
| ----------------------------------------------------- | ------------------------------------- |
| MCP input message/body                                | 64 MiB including JSON/base64 overhead |
| Decoded stdin, uploads and inline file input together | 32 MiB per call                       |
| Captured native stdout and stderr together            | 32 MiB per call                       |
| One output file                                       | 32 MiB                                |
| Retained artifacts                                    | 64 MiB per process                    |
| Simultaneous native calls                             | 4                                     |
| Native execution timeout                              | 120 seconds by default                |

Limit failures report an error rather than returning silent truncation. Native backends and MCP clients can impose smaller limits.

## Process lifecycle

Stdio EOF and SIGINT/SIGTERM close the connection and clean native calls/workspaces. HTTP uses SIGINT/SIGTERM; closed stdin does not stop a background HTTP service. Native commands requiring a terminal/editor remain registered, but the server supplies stdin plus EOF, not a TTY. Complete interactive configuration or authorization with the native CLI before using the MCP server.

Use `--cache-dir` for downloaded binaries, `--workspace-dir` for temporary call workspaces, and `--policy` only for your chosen exclusions. Protect native configuration, credentials, and policy outside the call workspace. [Security](../SECURITY.md) defines the deployment trust boundary.

On Windows, put `--config` and `--workspace-dir` on the same drive. The adapter uses a relative configuration path to preserve the native CLI's `:` delimiter; a configuration filename containing that delimiter cannot be represented and produces `config_binding`.
