import { BashArity } from "@/permission/arity"
import { ShellKind } from "./id"

export namespace ShellArity {
  export function prefix(tokens: string[], shellType: ShellKind.ID) {
    if (ShellKind.powershell(shellType) && tokens.length > 0 && /^[a-z]+-[a-z]+$/i.test(tokens[0])) {
      return [tokens[0]]
    }
    return BashArity.prefix(tokens)
  }
}
