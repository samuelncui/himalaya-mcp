# Third-party notices

The adapter's MIT license does not replace licenses for upstream software.
Bundled dependency code retains the notices listed below. Original license files are copied verbatim under `docs/licenses/`, which is included in the npm package; esbuild also emits `dist/cli.js.LEGAL.txt` when linked legal comments exist.

| Component                            | License       | Original notice                                                |
| ------------------------------------ | ------------- | -------------------------------------------------------------- |
| `@hono/node-server` 1.19.17          | MIT           | [LICENSE](docs/licenses/hono-node-server-license.txt)          |
| `@isaacs/fs-minipass` 4.0.1          | ISC           | [LICENSE](docs/licenses/isaacs-fs-minipass-license.txt)        |
| `@modelcontextprotocol/core` 2.3.0   | Apache-2.0    | [LICENSE](docs/licenses/modelcontextprotocol-core-license.txt) |
| `@modelcontextprotocol/node` 2.1.1   | Apache-2.0    | [LICENSE](docs/licenses/modelcontextprotocol-core-license.txt) |
| `@modelcontextprotocol/server` 2.3.0 | Apache-2.0    | [LICENSE](docs/licenses/modelcontextprotocol-core-license.txt) |
| `ajv` 8.20.0                         | MIT           | [LICENSE](docs/licenses/ajv-license.txt)                       |
| `chownr` 3.0.0                       | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/chownr-license.md.txt)              |
| `fast-deep-equal` 3.1.3              | MIT           | [LICENSE](docs/licenses/fast-deep-equal-license.txt)           |
| `fast-uri` 3.1.8                     | BSD-3-Clause  | [LICENSE](docs/licenses/fast-uri-license.txt)                  |
| `hono` 4.13.13                       | MIT           | [LICENSE](docs/licenses/hono-license.txt)                      |
| `json-schema-traverse` 1.0.0         | MIT           | [LICENSE](docs/licenses/fast-deep-equal-license.txt)           |
| `minipass` 7.1.3                     | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/minipass-license.md.txt)            |
| `minizlib` 3.1.0                     | MIT           | [LICENSE](docs/licenses/minizlib-license.txt)                  |
| `require-from-string` 2.0.2          | MIT           | [license](docs/licenses/require-from-string-license.txt)       |
| `tar` 7.5.22                         | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/minipass-license.md.txt)            |
| `yallist` 5.0.0                      | BlueOak-1.0.0 | [LICENSE.md](docs/licenses/chownr-license.md.txt)              |
| `yaml` 2.9.1                         | ISC           | [LICENSE](docs/licenses/yaml-license.txt)                      |
| `zod` 4.6.5                          | MIT           | [LICENSE](docs/licenses/zod-license.txt)                       |

The MCP SDK LICENSE contains its Apache-2.0/MIT licensing-transition statement and applicable full texts; keep that file intact. This package does not redistribute SDK documentation as its own.

Generated command metadata and Help originate from [Himalaya](https://github.com/pimalaya/himalaya), licensed `MIT OR Apache-2.0`: [MIT text](docs/licenses/himalaya-LICENSE-MIT.txt), [Apache text](docs/licenses/himalaya-LICENSE-APACHE.txt). The original Himalaya executable is obtained separately from its official release, rather than embedded or modified by this npm package. Its own and its dependencies' licenses continue to apply.

Development-only tools are governed by their installed licenses and are not included as runtime dependencies. When changing the bundled dependency graph, refresh these notices from the resolved package files and verify the packed artifact includes them. Do not infer licensing merely from package names.
