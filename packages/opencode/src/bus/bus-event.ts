import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"

export type Definition<Type extends string = string, Properties extends Schema.Top = Schema.Top> = {
  type: Type
  properties: Properties
}

const registry = new Map<string, Definition>()

export function define<Type extends string, Properties extends Schema.Top>(
  type: Type,
  properties: Properties,
): Definition<Type, Properties> {
  const result = { type, properties }
  registry.set(type, result)
  return result
}

// Optional source-of-truth metadata for event-sourcing replay. Present on
// GlobalBus events that originated from `SyncEvent.run`; absent on transient
// bus events that don't have an event log entry. Consumers that replay the
// event log (cross-instance sync) filter by `payload.sync != null`.
const Sync = Schema.Struct({
  name: Schema.String,
  seq: Schema.Finite,
  aggregateID: Schema.String,
  data: Schema.Unknown,
}).annotate({ identifier: "Event.Sync" })

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(type),
          properties: def.properties,
          sync: Schema.optional(Sync),
        }).annotate({ identifier: `Event.${type}` }),
      )
      .toArray(),
    ...EventV2.registry
      .values()
      .map((definition) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(definition.type),
          properties: definition.data,
          sync: Schema.optional(Sync),
        }).annotate({ identifier: `Event.${definition.type}` }),
      )
      .toArray(),
  ]
}

export * as BusEvent from "./bus-event"
