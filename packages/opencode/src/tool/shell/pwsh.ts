import { createShellTool } from "./util"

export const PwshTool = createShellTool({
  id: "pwsh",
  shellName: "PowerShell Core",
  toolName: "PowerShell",
  listCmd: "Get-ChildItem",
  gitCmds: "git commands",
  chaining:
    "use a single PowerShell call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`).",
  guidance: `# PowerShell 7+ (pwsh) shell notes
- This cross-platform shell supports pipeline chain operators (\`&&\` and \`||\`).
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Cmdlets use Verb-Noun naming (e.g., \`Get-ChildItem\`, \`Set-Content\`). Common aliases like \`ls\`, \`cat\`, \`rm\` execute the equivalent PowerShell cmdlets.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with backtick (\\\`).`,
})
