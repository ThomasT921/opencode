type Definition = {
  [method: string]: (input: any) => any
}

type RpcError = {
  name?: string
  message: string
  stack?: string
  props?: Record<string, unknown>
}

function serializeValue(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function serializeError(error: unknown): RpcError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      props: Object.fromEntries(
        Object.getOwnPropertyNames(error).map((key) => [key, serializeValue(error[key as keyof Error])]),
      ),
    }
  }
  return {
    message: String(error),
  }
}

function deserializeError(error: RpcError) {
  const result = new Error(error.message)
  if (error.name) result.name = error.name
  if (error.stack) result.stack = error.stack
  if (error.props) Object.assign(result, error.props)
  return result
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
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: unknown) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const callbacks = pending.get(parsed.id)
      if (callbacks) {
        callbacks.resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.error") {
      const callbacks = pending.get(parsed.id)
      if (callbacks) {
        callbacks.reject(deserializeError(parsed.error))
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
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
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

export * as Rpc from "./rpc"
