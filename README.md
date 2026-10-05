# himalaya-mcp

The original [Himalaya CLI](https://github.com/pimalaya/himalaya) as automatically generated MCP tools. Upstream defines commands, arguments, aliases, and Help. This adapter serializes structured inputs and runs the unmodified binary; it does not implement another email client.

Use Node **22.19 or newer**; [Node 24 LTS](https://nodejs.org/en/about/previous-releases) is recommended. An installed npm package needs no Rust, Python, native parser helper, or compilation. First `serve` downloads the matching official binary to a private cache and verifies both archive and executable SHA-256. A compatible local binary can be selected explicitly.

## Install and connect

Confirm that the selected version exists on npm before connecting. If it is unavailable, use a verified package artifact from the release workflow; the configuration below is an example, not evidence of publication.

After publication, start with one command (configure accounts in Himalaya first):

```sh
npx -y himalaya-mcp@latest
npx -y himalaya-mcp@latest doctor --json
```

Pin an available release in your MCP client:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": [
        "--yes",
        "himalaya-mcp@2.2.1-adapter.0.1.4",
        "serve",
        "--config",
        "/absolute/path/to/config.toml",
        "--operation-dir",
        "/absolute/private/path/to/operations"
      ]
    }
  }
}
```

Replace the version with an available release and the path with your existing native Himalaya configuration. The adapter does not register OAuth applications, obtain credentials, or configure accounts. Account and backend selection remain native CLI parameters.

Once installed:

```sh
himalaya-mcp describe --json
himalaya-mcp doctor --json --config /absolute/path/to/config.toml
himalaya-mcp serve --config /absolute/path/to/config.toml
```

`describe` lists generated tools and Help without executing Himalaya. `doctor` inspects local binary metadata, catalog integrity, and explicit configuration/policy paths; it neither downloads a binary nor connects to an email account. It can report `binary_missing` before first `serve`.

For a local HTTP client:

```sh
himalaya-mcp serve --transport http --host 127.0.0.1 --port 3000 --config /absolute/path/to/config.toml
```

The endpoint is `http://127.0.0.1:3000/mcp`. HTTP has Host/Origin checks, **no built-in user authentication**. Use only trusted clients and let your private deployment or tunnel enforce access. One process represents one trusted user's configured accounts.

## Calling tools

The MCP server provides common file and send-verification instructions during initialization, separate from automatically exported native Help. Clients should apply those instructions together with each tool schema.

Every native call requires a unique, stable `request_id`. The server saves an operation receipt before execution; a slow call returns its ID after approximately two seconds while execution continues. After a lost response, query `himalaya_mcp_operation_status` with the original `request_id` or returned `operation.id`; prefer `include_result=false` for completion checks without large output. Use `himalaya_mcp_operations_list` if neither identifier is available. Identical requests reuse the retained receipt rather than executing again; changed inputs under the same ID are rejected. Deduplication is bounded by history retention (up to 24 hours / 128 records). Missing history, interrupted results, or `unknown` never justify automatic resending. Native exit 0 confirms completion or backend acceptance for sending, not recipient delivery.

`--operation-dir` selects private persistent metadata; raw inputs, URLs, and email content are not saved. Full output is temporary in-memory data. Use one directory per live server, including separate diagnostic instances. A live PID owner blocks concurrent startup; recovered incomplete operations remain `unknown` without replay. See [the operation and file contract](docs/usage.md).

Tools accept structured native `params` plus generated top-level file fields such as `attach`. Declared file arguments are not duplicated under `params`. A file field takes client objects containing `file_id` and `download_url`, identified through `openai/fileParams` metadata. The generic runtime imports each complete file and binds it to the original CLI. Shared byte uploads, stdin mail inputs, and inline raw-mail inputs have been removed from the public API.

A compatible client's file forwarding is required; a file ID alone, client path, or resource URI is not an input. If that channel is missing, report the client limitation without reconstructing files or trying workspace transfers. Complete raw mail is imported as one `.eml` object. Operation responses preserve available native exit status and stdout/stderr, and output resources allow retrieval without promising automatic re-input. See [the file contract](docs/usage.md) for schemas, limits, and client verification.

An optional, personally maintained YAML policy excludes operations you choose. It is never installed automatically; sending and attachments are not excluded by the supplied example. Runtime tool availability filtering hides wholly excluded and terminal-only commands; conditional exclusions are checked on each call. Read [policy behavior](docs/policy.md) before enabling `--policy`. Annotations describe effects and do not prove approval.

The generated schema and server-side bridge do not establish that a live ChatGPT connection forwards files correctly; real client acceptance must be verified separately.

The release manifest targets macOS arm64/x64, Linux arm64/x64, and Windows x64. Actual platform results belong to CI and release artifacts; a target listed here is not a claim that it has been tested successfully.

## Develop and maintain

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and the [release and recovery procedure](docs/maintenance.md). Development requires Rust to reflect and test upstream Clap definitions; end-user packages do not.

[Security boundaries](SECURITY.md) · [MIT license](LICENSE) · [third-party notices](THIRD_PARTY_NOTICES.md)
