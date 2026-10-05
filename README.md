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
        "himalaya-mcp@2.2.1-adapter.0.1.1",
        "serve",
        "--config",
        "/absolute/path/to/config.toml"
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

Tools accept generated `params` plus optional `stdin`, `stdinBase64`, and uploaded `files`. Results preserve native exit status and stdout/stderr; generated files are exposed as MCP resources. RFC822/MIME and attachment handling stay with Himalaya. See [the call contract](docs/usage.md) for shapes, file boundaries, and limits.

An optional, personally maintained YAML policy excludes operations you choose. It is never installed automatically; sending and attachments are not excluded by the supplied example. MCP annotations describe effects and do not prove approval. Read [policy behavior](docs/policy.md) before enabling `--policy`.

The release manifest targets macOS arm64/x64, Linux arm64/x64, and Windows x64. Actual platform results belong to CI and release artifacts; a target listed here is not a claim that it has been tested successfully.

## Develop and maintain

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and the [release and recovery procedure](docs/maintenance.md). Development requires Rust to reflect and test upstream Clap definitions; end-user packages do not.

[Security boundaries](SECURITY.md) · [MIT license](LICENSE) · [third-party notices](THIRD_PARTY_NOTICES.md)
