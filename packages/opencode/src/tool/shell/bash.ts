import { createShellTool } from "./util"

export const BashTool = createShellTool({
  id: "bash",
  shellName: "bash",
  toolName: "Bash",
  listCmd: "ls",
  gitCmds: "git bash commands",
  chaining:
    "use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`).",
  guidance: "",
})
