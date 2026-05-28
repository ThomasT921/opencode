# V2 Config Review

This document breaks the legacy configuration schema into small review groups. Work through one group at a time and decide whether each field should be ported as-is, removed, or redesigned for v2.

## Status Labels

- `pending`: not discussed yet
- `keep`: port with substantially the existing meaning
- `remove`: do not carry forward
- `redesign`: keep the capability with a different shape, scope, or owning module

## Schema Scope

Use one v2 config schema for now. Some fields, such as `autoupdate`, are intended for global/user configuration, but there is not yet enough benefit to enforce that with separate global and location schemas. Revisit this if more scope-sensitive fields survive the review.

## Group 1: File Metadata

Small fields describing the config file itself rather than application behavior.

| Field     | Current Purpose                                            | Status | Notes                                                                                 |
| --------- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `$schema` | JSON schema reference for editor validation and completion | keep   | Keep as read-only metadata; loading config must not insert it or create files for it. |

## Group 2: Process And Server Settings

Settings that affect process startup, shell execution, or network serving. Review global-only versus location-specific scope carefully.

| Field        | Current Purpose                                     | Status | Notes                                                                          |
| ------------ | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| `shell`      | Default shell for terminal and shell tool execution | keep   | Port as effective config; shared shell choice is used throughout opencode.     |
| `logLevel`   | Intended logging level configuration                | remove | Do not port: no config consumer exists and logging initializes from CLI input. |
| `server`     | Hostname, port, mDNS, and CORS settings             | remove | Do not port: location config is loaded after the server is already running.    |
| `autoupdate` | Automatic update or notification behavior           | keep   | Global-only user preference; keep `true`, `false`, and `"notify"`.             |

## Group 3: Commands And Project Resources

Configuration that introduces location-scoped project resources or discoverable content.

| Field          | Current Purpose                         | Status | Notes                                                                                                         |
| -------------- | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `command`      | User-defined commands                   | remove | Do not port as v2 config; named reusable user workflows belong to skills.                                   |
| `skills`       | Additional skill locations              | redesign | Replace `{ paths?, urls? }` with a single array of local path or remote URL discovery sources.                           |
| `reference`    | Named git or local directory references | redesign | Rename to plural `references`; retain named local path and Git repository external-context entries.        |
| `instructions` | Additional ambient instruction sources  | keep     | Keep as one array of local paths, glob patterns, or remote URLs supplying automatically included context.   |

V2 does not expose separate user-authored command configuration. Skills should cover named reusable prompt workflows, whether invoked directly by the user or loaded by an agent. Internal command routing and built-in commands may remain runtime concerns without creating a `command` or `commands` config field.

This intentionally does not port legacy command-only behavior such as per-command `model`, `agent`, `subtask`, prompt shell expansion, or positional/template substitution. If a related capability is needed in v2, it should be designed in the owning domain rather than preserved through a second workflow definition system.

Keep `skills` as discovery-source configuration rather than inline workflow definitions. Skill content remains owned by `SKILL.md`; each `skills` entry is either a local search root or a remote discovery URL. Direct invocation behavior can be designed separately without expanding the config shape.

```jsonc
{
  "skills": ["./team-skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
}
```

Keep ambient instructions separate from skills. Instructions are automatically included as model context, while skills are loaded or invoked intentionally. Each source is unambiguously either a local path/glob or a URL, so v2 keeps the simple array shape:

```jsonc
{
  "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
}
```

Keep named external context references as a v2 configuration capability, renamed to plural `references` because it is a collection keyed by alias. References declare local directories or Git repositories that can later be addressed as `@alias` or `@alias/path` when the v2 runtime implements this behavior.

```jsonc
{
  "references": {
    "design-system": { "path": "../ui-library" },
    "sdk": { "repository": "github.com/example/sdk", "branch": "main" },
  },
}
```

Retain the compact string entry form as well: values starting with `.`, `/`, or `~` represent local paths, and other strings represent Git repositories.

## Group 4: Plugins

Plugin loading has source-path and scope-sensitive behavior, so it should be reviewed separately from other project resources.

| Field    | Current Purpose               | Status   | Notes                                                                                                                 |
| -------- | ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `plugin` | User-specified plugin modules | redesign | Rename to plural `plugins`; retain ordered loading with package strings or `{ package, options? }` entries.         |

Plugin order remains part of the v2 configuration contract because hook registration and execution can depend on load order. Replace legacy option tuples with readable object entries:

```jsonc
{
  "plugins": [
    "opencode-helicone-session",
    {
      "package": "@my-org/audit-plugin",
      "options": {
        "endpoint": "https://audit.example.com",
      },
    },
  ],
}
```

The configured `plugins` list represents package-loaded plugins only. Local plugin code remains discovered from plugin directories such as `.opencode/plugins/`; v2 does not port arbitrary configured local paths or file URLs into this field.

## Group 5: Filesystem And Tool Runtime

Settings controlling local file observation, snapshots, language tooling, and tool output behavior.

| Field         | Current Purpose                         | Status  | Notes |
| ------------- | --------------------------------------- | ------- | ----- |
| `watcher`     | Ignore patterns for filesystem watching | keep     | Keep `{ ignore?: string[] }`; this configures the filesystem watcher subsystem. |
| `snapshot`    | Enable filesystem snapshot tracking     | redesign | Rename to plural `snapshots`; controls creation of snapshots used for undo and revert behavior. |
| `formatter`   | Configure formatters                    | keep     | Keep singular `boolean \| Record<string, entry>` shape; it configures built-in enablement and named formatter overrides. |
| `lsp`         | Configure language servers              | keep     | Keep singular `boolean \| Record<string, entry>` shape; custom servers need commands and file extensions. |
| `attachment`  | Configure attachment/image processing   | redesign | Rename to plural `attachments`; retain `{ image?: { auto_resize?, max_width?, max_height?, max_base64_bytes? } }` for input normalization limits. |
| `tool_output` | Configure tool output truncation limits | keep     | Keep `{ max_lines?, max_bytes? }`; both positive thresholds apply to saved-preview truncation behavior. |

`formatter` and `lsp` configure one project tooling subsystem each, so their singular names remain appropriate. `true` enables the built-in registrations, `false` disables them, and a keyed object enables built-ins while applying named overrides or custom registrations. Custom language servers must declare `extensions` so runtime file attachment is deterministic; validation of known built-in server IDs belongs with the eventual v2 LSP integration rather than the aggregate core config schema.

Rename legacy `attachment` to `attachments` in v2. This setting controls processing for the attachment domain and may expand beyond image handling, while singular `attachment` is already used as a model capability flag indicating whether one model accepts attachments.

```jsonc
{
  "formatter": {
    "prettier": { "disabled": true },
    "project": { "command": ["./scripts/format", "$FILE"], "extensions": [".foo"] },
  },
  "lsp": {
    "typescript": { "disabled": true },
    "project": { "command": ["project-language-server", "--stdio"], "extensions": [".foo"] },
  },
  "attachments": {
    "image": { "auto_resize": true, "max_width": 2000, "max_height": 2000 },
  },
  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },
}
```

## Group 6: Sharing And Identity

Settings affecting sharing behavior or user/account identity rather than model execution.

| Field        | Current Purpose                                 | Status  | Notes                           |
| ------------ | ----------------------------------------------- | ------- | ------------------------------- |
| `share`      | Session sharing behavior                        | keep   | Keep `"manual" \| "auto" \| "disabled"`; it controls manual sharing permission and automatic sharing of new sessions. |
| `autoshare`  | Legacy automatic sharing flag                   | remove | Do not port deprecated alias; use `share: "auto"`. |
| `enterprise` | Enterprise URL configuration                    | keep   | Keep `{ url?: string }`; currently selects the legacy sharing service endpoint when no organization account is active. |
| `username`   | Display username in conversations and telemetry | keep   | Keep string identity override; runtime may otherwise resolve an operating-system username. |

Retain `share` as the single session-sharing setting. `"manual"` permits explicit sharing, `"auto"` shares newly created top-level sessions, and `"disabled"` prevents sharing. Legacy `autoshare: true` is only an alias for `share: "auto"`, so v2 does not expose it.

Retain `enterprise.url` for legacy enterprise share hosting selection and `username` as a user-facing identity override. These remain separate from server authentication credentials; `username` identifies the user in conversation and telemetry behavior rather than HTTP basic-auth configuration.

```jsonc
{
  "share": "disabled",
  "enterprise": { "url": "https://share.example.com" },
  "username": "developer",
}
```

## Group 7: Providers And Model Selection

Provider catalog customization and model-choice configuration. The new core work has started here.

| Field                | Current Purpose                                   | Status   | Notes                                                                                                                   |
| -------------------- | ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `provider`           | Custom provider configuration and model overrides | redesign | Rename to plural `providers` in v2; do not preserve the legacy singular key. Review nested provider/model fields separately. |
| `disabled_providers` | Disable automatically loaded providers            | redesign | Replace with `experimental.policies: [{ effect: "deny", action: "provider.use", resource: "..." }]`.               |
| `enabled_providers`  | Restrict enabled providers to an allowlist        | redesign | Replace with ordered `provider.use` allow/deny statements and wildcard resources.                                       |
| `model`              | Default model selection                           | keep     | Keep as the fallback model when an active session or agent does not specify a model.                                   |
| `small_model`        | Small/utility model selection                     | remove   | Do not port; its only runtime consumer is title generation, which can use an explicit `title` agent model override.    |

Provider selection rules belong in `experimental.policies` rather than provider entries or repeated top-level provider fields. Initial proposed shape:

```jsonc
{
  "experimental": {
    "policies": [
      {
        "effect": "deny",
        "action": "provider.use",
        "resource": "*",
      },
      {
        "effect": "allow",
        "action": "provider.use",
        "resource": "anthropic",
      },
    ],
  },
}
```

See [provider-policy.md](./provider-policy.md) for the provider policy semantics and precedence rules.

Policy evaluation will consume authored config documents in reverse order while preserving statement order inside each document. The precedence of `.opencode` policy sources remains open until `.opencode` configuration is reviewed.

Provider configuration uses the plural `providers` key in v2. This intentionally differs from the legacy singular `provider` key; v2 does not add a compatibility alias while its configuration surface is still being defined.

Keep `model` as the default model fallback. It is application-wide behavior used when an active session or agent has no explicit model selection, so it does not belong inside any individual provider configuration.

Do not port `small_model`. In the current runtime it is only consulted while generating a session title: the `title` agent model wins first, then `small_model`, then automatic/current-model fallback. In v2, users who need a specific title model should configure the `title` agent directly rather than use a separate top-level model setting.

## Group 8: Agents And Permissions

Agent behavior and tool-access policy. Review together because agent configuration can contain permissions and model choices.

| Field           | Current Purpose                                     | Status  | Notes                                       |
| --------------- | --------------------------------------------------- | ------- | ------------------------------------------- |
| `default_agent` | Choose default primary agent                        | pending |                                             |
| `mode`          | Legacy agent configuration alias                    | pending | Deprecated in favor of `agent`.             |
| `agent`         | Configure primary, subagent, and specialized agents | pending |                                             |
| `permission`    | Tool permission rules                               | pending |                                             |
| `tools`         | Legacy tool enable/disable map                      | pending | Converted to permissions by current loader. |

## Group 9: Integrations

External protocol and server integration configuration.

| Field | Current Purpose                       | Status  | Notes |
| ----- | ------------------------------------- | ------- | ----- |
| `mcp` | MCP server definitions and enablement | pending |       |

## Group 10: Conversation Lifecycle

Behavior affecting long-running conversations and context management.

| Field        | Current Purpose                                             | Status  | Notes |
| ------------ | ----------------------------------------------------------- | ------- | ----- |
| `compaction` | Automatic compaction, pruning, and context reserve settings | pending |       |

## Group 11: Deprecated And Experimental Settings

Fields that should not be ported by inertia; each needs an explicit justification.

| Field                                | Current Purpose                         | Status  | Notes                                                               |
| ------------------------------------ | --------------------------------------- | ------- | ------------------------------------------------------------------- |
| `layout`                             | Legacy layout selection                 | pending | Deprecated; current description says stretch layout is always used. |
| `experimental.disable_paste_summary` | Disable pasted-content summary behavior | pending |                                                                     |
| `experimental.batch_tool`            | Enable batch tool                       | pending |                                                                     |
| `experimental.openTelemetry`         | Enable AI SDK telemetry spans           | pending |                                                                     |
| `experimental.primary_tools`         | Restrict tools to primary agents        | pending |                                                                     |
| `experimental.continue_loop_on_deny` | Continue loop after denied tool call    | pending |                                                                     |
| `experimental.mcp_timeout`           | MCP request timeout                     | pending | May belong with MCP rather than experiments.                        |

## Review Order

Work through the groups in this order unless a dependency between decisions becomes clear:

1. File Metadata
2. Process And Server Settings
3. Providers And Model Selection
4. Commands And Project Resources
5. Plugins
6. Filesystem And Tool Runtime
7. Sharing And Identity
8. Agents And Permissions
9. Integrations
10. Conversation Lifecycle
11. Deprecated And Experimental Settings
