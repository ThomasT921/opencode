type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      try {
        const result = await rpc[parsed.method](parsed.input)
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (error) {
        postMessage(JSON.stringify({ type: "rpc.error", error: serializeError(error), id: parsed.id }))
      }
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  addEventListener?: Worker["addEventListener"]
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: any) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let failed: unknown
  let id = 0
  const rejectPending = (error: unknown) => {
    failed = error
    for (const request of pending.values()) {
      request.reject(error)
    }
    pending.clear()
  }
  target.addEventListener?.("error", (event) => {
    rejectPending(errorFromEvent(event))
  })
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const request = pending.get(parsed.id)
      if (request) {
        request.resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.error") {
      const request = pending.get(parsed.id)
      if (request) {
        request.reject(deserializeError(parsed.error))
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      if (failed) return Promise.reject(failed)
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(error)
        }
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

function errorFromEvent(event: Event): unknown {
  const errorEvent = event as { error?: unknown; message?: unknown }
  if (errorEvent.error) return errorEvent.error
  if (typeof errorEvent.message === "string" && errorEvent.message) return new Error(errorEvent.message)
  return new Error("Worker failed")
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  return {
    ...Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, error[key as keyof Error]])),
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: serializeError(error.cause),
  }
}

function deserializeError(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("message" in input)) return input
  const serialized = input as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }
  const error = new Error(typeof serialized.message === "string" ? serialized.message : String(serialized.message), {
    cause: deserializeError(serialized.cause),
  })
  if (typeof serialized.name === "string") error.name = serialized.name
  if (typeof serialized.stack === "string") error.stack = serialized.stack
  Object.assign(error, input)
  return error
}

export * as Rpc from "./rpc"
