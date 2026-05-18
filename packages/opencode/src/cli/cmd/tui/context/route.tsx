import { createStore, reconcile } from "solid-js/store"
import { Option, Schema } from "effect"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"
import { tryJsonConfig } from "@/util/json"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

const HOME_ROUTE: Route = { type: "home" }

// Schema covers only the env-fed shape — `prompt` is set programmatically and
// not expected from OPENCODE_ROUTE, so we keep it out of validation.
export const RouteSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("home") }),
  Schema.Struct({ type: Schema.Literal("session"), sessionID: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("plugin"),
    id: Schema.String,
    data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
])

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const fromEnv = tryJsonConfig(process.env["OPENCODE_ROUTE"], RouteSchema, "OPENCODE_ROUTE")
    const [store, setStore] = createStore<Route>(props.initialRoute ?? Option.getOrElse(fromEnv, () => HOME_ROUTE))

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
