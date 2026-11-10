# Local API configuration discovery

WeWorker reads supported user-level model configuration files when the backend
starts. Settings > Extensions > Model discovery controls startup detection and
import; it is enabled by default. Disabling it leaves existing configurations
unchanged and skips startup discovery.

The model settings toolbar and chat provider menu open a discovery dialog.
Manual scans show one candidate per row without importing anything. Selecting a
row imports only that configuration as a custom provider named after its source
app. Already imported sources are marked and cannot be imported twice. Manual
discovery works even when startup detection is disabled. Candidate responses
contain public connection metadata only; import requests carry only a source ID,
and credentials are resolved again on the backend.

| Product | Configuration files |
| --- | --- |
| Claude Code | `~/.claude/settings.json`, `settings.local.json`; honors `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/config.toml`, `auth.json`; honors `CODEX_HOME` and the active profile |
| WorkBuddy | `~/.workbuddy/settings.json`, `models.json`; honors `WORKBUDDY_CONFIG_DIR`, then `CODEBUDDY_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy/settings.json`, `models.json`; honors `CODEBUDDY_CONFIG_DIR` |
| OpenCode | `~/.config/opencode/opencode.json` / `opencode.jsonc`, `~/.local/share/opencode/auth.json`; honors XDG directories |

WorkBuddy model arrays and CodeBuddy `{ "models": [] }` objects are supported.
Codex imports the selected provider's explicit API key or environment key;
OpenCode imports selected providers using explicit AI SDK protocol and base URL
settings, or the official Anthropic/OpenAI defaults. Environment references use `${VARIABLE}`; OpenCode also supports
`{env:VARIABLE}`. Unresolved references are skipped. Arbitrary `{file:...}`
references and executable credential helpers are not followed.

Only API credentials are imported. Product OAuth sessions, browser data,
conversation histories, project configuration and login tokens are not read.
Original files are never changed. Imported keys use WeWorker's existing encrypted
settings storage and are excluded from HTTP responses and logs.

Existing selections and edited configurations are preserved. On an unconfigured
installation, the first complete imported configuration becomes active and
completes the initial model setup. A key and
URL without a model can still be imported: selecting that provider queries its
model catalog and saves the first available model before activation. If the
service has no catalog, choose a model in settings. Discovery itself makes no
network requests. Unsupported protocols and incomplete credentials are skipped.

Deleting an imported provider remembers that source, so startup does not recreate
it. Manual detection can import it again. Switch to another provider before
deleting the currently active configuration.

Format references: [Claude Code](https://code.claude.com/docs/en/settings),
[Codex](https://developers.openai.com/codex/config-reference),
[WorkBuddy](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model),
[CodeBuddy](https://www.codebuddy.ai/docs/cli/models),
[OpenCode](https://opencode.ai/docs/config/).
