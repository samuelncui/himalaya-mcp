# Working in this repository

This project exposes the original Himalaya CLI through MCP. Keep the adapter small.

- Read `docs/architecture.md` for ownership and `docs/maintenance.md` for the release procedure.
- CLI registration, argument syntax, aliases, and Help belong to upstream. Change the generator and regenerate; never maintain a hand-written command registry or edit generated definitions.
- The runtime is JavaScript. Rust is generation/test tooling only. Published packages must not compile or contain a native parser helper.
- Use one generic argument serializer, subprocess executor, file boundary, and policy evaluator. Do not write email-command handlers, MIME builders, or a second email client.
- User policy is authoritative. Examples are opt-in; do not install, broaden, or overwrite a user's policy.
- Preserve unknown information as unknown. Native Himalaya validates business values and argument conflicts. Do not invent native defaults or silently omit unsupported CLI syntax.
- Do not put credentials, real account configuration, or email content in source control, CI, fixtures, or logs. Tests use synthetic mail and temporary directories.
- Keep TypeScript strict and errors actionable. Avoid shell execution and automatic retries of writes.
- Run `npm run check`, the native argument differential check, and the packed-package smoke check. Report platform or client checks that did not run.
- Delegate substantial independent work with explicit ownership; the integrating agent reviews actual changes and runs combined checks. Do not let agents write the same files concurrently.
- Clean temporary resources. Do not operate an existing mailbox, NAS service, or deployment as part of repository development.

Normal source changes are reviewed through pull requests. Upstream automation generates release artifacts without modifying main. Fix generic compatibility failures rather than adding special cases for commands.
