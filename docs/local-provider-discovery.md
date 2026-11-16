# Local API configuration discovery

WeWorker reads supported user-level model configuration files when the backend
starts. Settings > Extensions > Model discovery controls startup detection and
import; it is enabled by default. Disabling it leaves existing configurations
unchanged and skips startup discovery.

The model settings toolbar and chat provider menu open a discovery dialog.
The header action “检测本地配置” scans and imports new validated connections without restarting, then reports imported, updated, merged and skipped entries in a dialog. It preserves the active selection and respects dismissed sources. The info icon explains this behavior.

The existing preview dialog shows one connection per row without importing anything. Selecting a
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
| DeepSeek Harness | `~/.dsh/.credentials.yaml`, `cordis.patch.yml`, `profiles/<profile>/cordis.patch.yml`; honors `DSH_HOME` |

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
service has no catalog, choose a model in settings. Discovery probes the model-list endpoint once per connection. A successful probe (or an unsupported model-list endpoint returning 404/405) is not a successful chat test. Failed validation blocks automatic import; the preview dialog still permits explicit manual import. Unsupported protocols and incomplete credentials are skipped.

Deleting an imported provider remembers that source, so startup does not recreate
it. Manual detection can import it again. Switch to another provider before
deleting the currently active configuration.

Format references: [Claude Code](https://code.claude.com/docs/en/settings),
[Codex](https://developers.openai.com/codex/config-reference),
[WorkBuddy](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model),
[CodeBuddy](https://www.codebuddy.ai/docs/cli/models),
[OpenCode](https://opencode.ai/docs/config/),
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md).

DeepSeek Harness discovery reads the official DeepSeek API-key route and explicit
`llm-pi-ai` custom routes using `openai-completions`, `openai-responses` or
`anthropic-messages` plus a base URL. Configured models sharing the same effective endpoint and API key appear as one import
candidate with a combined model list; a route without a saved model imports without inventing a model ID.
The version-1 credential store's `refs` (and the earlier flat reference map) take
precedence over launch environment variables. Explicit `apiKeyEnv` references
take precedence over `api-key` records. OAuth/grant records and the DeepSeek
account-login plugin are excluded. Home patches replace profile entry configs,
and disabled entries are skipped.

Discovery reads at most 100 profile directories and only their fixed patch files;
it does not execute DSH or load plugin bundles, project `.env` files, custom
credential stores, or command-line overlays. Routes relying on an installed
plugin catalog to supply their protocol or endpoint are skipped. These cases
still require manual configuration. Original Harness files are never modified.


Connection identity is based on the effective URL and API key, with protocol and
Anthropic authentication mode kept distinct. Different keys at the same URL stay
separate; identical routes from different apps are grouped. Model IDs and profile
names do not determine connection identity. Known models populate `custom_models`
so they remain selectable even without a remote catalog. Existing manually saved
connections are reused. Repeated scans append newly discovered model IDs without
changing the selected model or overwriting credentials.

Legacy model-per-row imports are matched by their previous source IDs. Only
entries with generated names and otherwise identical settings are folded, keeping
the active configuration ID where possible. Renamed or independently edited
entries remain intact. Deletion dismissals recognize both old and new source IDs.
