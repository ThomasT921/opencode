import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: { params: { providerID: ProviderID } }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const entry = (() => {
        if (ctx.payload.level === "debug") return Effect.logDebug(ctx.payload.message)
        if (ctx.payload.level === "warn") return Effect.logWarning(ctx.payload.message)
        if (ctx.payload.level === "error") return Effect.logError(ctx.payload.message)
        return Effect.logInfo(ctx.payload.message)
      })()
      yield* entry.pipe(Effect.annotateLogs({ service: ctx.payload.service, ...ctx.payload.extra }))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
