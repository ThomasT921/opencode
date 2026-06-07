import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { DateTime, Deferred, Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const parentID = SessionV2.ID.make("ses_task_parent")
const childID = SessionV2.ID.make("ses_task_child")
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const parent = new SessionV2.Info({
  id: parentID,
  projectID: ProjectV2.ID.make("project"),
  agent: AgentV2.ID.make("build"),
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  title: "Parent",
  location,
})
const child = new SessionV2.Info({
  id: childID,
  parentID,
  projectID: parent.projectID,
  agent: parent.agent,
  model: parent.model,
  cost: 0,
  tokens: parent.tokens,
  time: parent.time,
  title: "Child",
  location,
})
const assistant = new SessionMessage.Assistant({
  id: SessionMessage.ID.make("msg_task_assistant"),
  type: "assistant",
  agent: "explore",
  model: parent.model!,
  content: [new SessionMessage.AssistantText({ type: "text", id: "text", text: "Task output" })],
  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
})

describe("TaskTool", () => {
  const it = testEffect(Layer.empty)
  const resolveAgent = () => Effect.succeed(AgentV2.Info.empty(AgentV2.ID.make("explore")))

  it.effect("runs a foreground child with an admit-only steer and explicit resume", () =>
    Effect.gen(function* () {
      const inputs: Parameters<SessionV2.Interface["prompt"]>[0][] = []
      let resumed = 0
      const sessions = mockSessions({
        prompt: (input) => {
          inputs.push(input)
          return Effect.succeed(admission(input))
        },
        resume: () => Effect.sync(() => resumed++),
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)

      const result = yield* tool.execute(
        {
          description: "Map auth",
          prompt: "Map the authentication flow",
          subagent_type: "explore",
          background: false,
        },
        { sessionID: parentID, id: "call_task", name: "task" },
      )

      expect(result).toEqual({ sessionID: childID, status: "completed", output: "Task output" })
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({ sessionID: childID, delivery: "steer", resume: false })
      expect(resumed).toBe(1)
    }),
  )

  it.effect("rejects an unknown subagent before creating a child", () =>
    Effect.gen(function* () {
      let created = false
      const sessions = mockSessions({
        create: () =>
          Effect.sync(() => {
            created = true
            return child
          }),
        prompt: (input) => Effect.succeed(admission(input)),
        resume: () => Effect.void,
      })
      const tool = yield* TaskTool.make(sessions, () => Effect.succeed(undefined))

      const error = yield* tool
        .execute(
          {
            description: "Map auth",
            prompt: "Map the authentication flow",
            subagent_type: "missing",
          },
          { sessionID: parentID, id: "call_task_unknown", name: "task" },
        )
        .pipe(Effect.flip)

      expect(error.message).toBe("Unknown subagent: missing")
      expect(created).toBe(false)
    }),
  )

  it.live("returns before background completion and steers the result into the parent", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const notified = yield* Deferred.make<Parameters<SessionV2.Interface["prompt"]>[0]>()
      const inputs: Parameters<SessionV2.Interface["prompt"]>[0][] = []
      const sessions = mockSessions({
        prompt: (input) => {
          inputs.push(input)
          return input.sessionID === parentID
            ? Deferred.succeed(notified, input).pipe(Effect.as(admission(input)))
            : Effect.succeed(admission(input))
        },
        resume: () => Deferred.await(gate),
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)

      const result = yield* tool.execute(
        {
          description: "Map auth",
          prompt: "Map the authentication flow",
          subagent_type: "explore",
          background: true,
        },
        { sessionID: parentID, id: "call_task_background", name: "task" },
      )

      expect(result).toEqual({ sessionID: childID, status: "running" })
      expect(inputs).toHaveLength(1)
      yield* Deferred.succeed(gate, undefined)
      const notification = yield* Deferred.await(notified)
      expect(notification).toMatchObject({ sessionID: parentID, delivery: "steer" })
      expect(notification.prompt.text).toContain("Background task completed: Map auth")
      expect(notification.prompt.text).toContain("Task output")
    }),
  )
})

function mockSessions(overrides: {
  create?: SessionV2.Interface["create"]
  prompt: SessionV2.Interface["prompt"]
  resume: SessionV2.Interface["resume"]
}): SessionV2.Interface {
  return {
    create: overrides.create ?? (() => Effect.succeed(child)),
    get: (id) => Effect.succeed(id === parentID ? parent : child),
    prompt: overrides.prompt,
    resume: overrides.resume,
    messages: () => Effect.succeed([assistant]),
    list: () => Effect.succeed([]),
    message: () => Effect.succeed(undefined),
    context: () => Effect.succeed([]),
    events: () => Stream.die("unused"),
    switchAgent: () => Effect.die("unused"),
    switchModel: () => Effect.die("unused"),
    shell: () => Effect.die("unused"),
    skill: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
    interrupt: () => Effect.void,
  }
}

function admission(input: Parameters<SessionV2.Interface["prompt"]>[0]) {
  return new SessionInput.Admitted({
    admittedSeq: 1,
    id: input.id ?? SessionMessage.ID.create(),
    sessionID: input.sessionID,
    prompt: input.prompt,
    delivery: input.delivery ?? "steer",
    timeCreated: DateTime.makeUnsafe(0),
  })
}
