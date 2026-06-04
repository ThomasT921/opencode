import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

type Endpoint = {
  postMessage(data: string): void
  onmessage: ((this: Worker, ev: MessageEvent<string>) => unknown) | null
}

function message(data: string) {
  return new MessageEvent("message", { data })
}

describe("util.rpc", () => {
  test("rejects calls when the handler throws", async () => {
    const main: Endpoint = {
      onmessage: null,
      postMessage(data) {
        queueMicrotask(() => worker.onmessage?.call({} as Worker, message(data)))
      },
    }
    const worker: Endpoint = {
      onmessage: null,
      postMessage(data) {
        queueMicrotask(() => main.onmessage?.call({} as Worker, message(data)))
      },
    }

    const previousOnMessage = globalThis.onmessage
    const previousPostMessage = globalThis.postMessage
    try {
      globalThis.postMessage = worker.postMessage
      Rpc.listen({
        boom() {
          throw new Error("boom")
        },
      })
      worker.onmessage = globalThis.onmessage as Endpoint["onmessage"]

      await expect(Rpc.client(main).call("boom", undefined)).rejects.toThrow("boom")
    } finally {
      globalThis.onmessage = previousOnMessage
      globalThis.postMessage = previousPostMessage
    }
  })
})
