import { describe, expect, test } from "bun:test"
import { Rpc } from "@/util/rpc"

type TestRpc = {
  fail(input: undefined): Promise<void>
}

type Target = Parameters<typeof Rpc.client<TestRpc>>[0]

describe("Rpc", () => {
  test("rejects pending calls when the worker reports an error", async () => {
    const target: Target = {
      postMessage(data) {
        const request = JSON.parse(data)
        target.onmessage?.call(
          {} as Worker,
          {
            data: JSON.stringify({
              type: "rpc.error",
              id: request.id,
              error: { name: "Error", message: "boom", stack: "Error: boom" },
            }),
          } as MessageEvent<any>,
        )
      },
      onmessage: null,
    }

    await expect(Rpc.client<TestRpc>(target).call("fail", undefined)).rejects.toThrow("boom")
  })

  test("rejects pending and future calls when the worker crashes", async () => {
    let onError: ((event: Event) => void) | undefined
    const target: Target = {
      postMessage() {},
      onmessage: null,
      addEventListener(type, listener) {
        if (type !== "error" || typeof listener !== "function") return
        onError = (event) => listener.call({} as Worker, event)
      },
    }
    const client = Rpc.client<TestRpc>(target)
    const pending = client.call("fail", undefined)

    onError?.({ message: "worker crashed" } as Event)

    await expect(pending).rejects.toThrow("worker crashed")
    await expect(client.call("fail", undefined)).rejects.toThrow("worker crashed")
  })
})
