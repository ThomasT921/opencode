export * from "./gen/effect.gen.js"

import { createOpencodeFetchClient, type OpencodeClientConfig } from "./client.js"
import { createOpencodeEffectClient as createGeneratedOpencodeEffectClient } from "./gen/effect.gen.js"

export function createOpencodeEffectClient(config?: OpencodeClientConfig) {
  return createGeneratedOpencodeEffectClient(createOpencodeFetchClient(config))
}
