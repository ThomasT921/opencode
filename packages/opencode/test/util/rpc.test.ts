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
              error: "boom",
            }),
          } as MessageEvent<any>,
        )
      },
      onmessage: null,
    }

    await expect(Rpc.client<TestRpc>(target).call("fail", undefined)).rejects.toThrow("boom")
  })
})
