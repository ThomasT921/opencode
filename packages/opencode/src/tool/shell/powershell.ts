import { createShellTool } from "./util"

export const PowershellTool = createShellTool({
  id: "powershell",
  shellName: "Windows PowerShell",
  toolName: "PowerShell",
  listCmd: "Get-ChildItem",
  gitCmds: "git commands",
  chaining:
    "use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success.",
  guidance: `# Windows PowerShell 5.1 shell notes
- Use \`cmd1; if ($?) { cmd2 }\` to chain dependent commands.
- Use double quotes for interpolated strings (\`"Hello $name"\`), single quotes for verbatim strings.
- Cmdlets use Verb-Noun naming (e.g., \`Get-ChildItem\`, \`Set-Content\`). Common aliases like \`ls\`, \`cat\`, \`rm\` execute the equivalent PowerShell cmdlets.
- Use \`$(...)\` for subexpressions. Use \`@(...)\` for array expressions.
- To call a native executable whose path contains spaces, use the call operator: \`& "path/to/exe" args\`.
- Escape special characters with backtick (\\\`).`,
})
