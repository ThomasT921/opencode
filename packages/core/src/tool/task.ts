export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Cause, Effect, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The specialized agent to use" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Return immediately and notify the parent Session when the task finishes",
  }),
})

export const Success = Schema.Struct({
  sessionID: SessionV2.ID,
  status: Schema.Literals(["running", "completed"]),
  output: Schema.String.pipe(Schema.optional),
})

type Sessions = Pick<SessionV2.Interface, "create" | "get" | "interrupt" | "messages" | "prompt" | "resume">

export const make = Effect.fn("TaskTool.make")(function* (
  sessions: Sessions,
  resolveAgent: (location: Location.Ref, id: AgentV2.ID) => Effect.Effect<AgentV2.Info | undefined>,
) {
  const scope = yield* Scope.Scope

  return Tool.make({
    description:
      "Delegate focused work to a specialized child agent. Foreground calls wait for the result; background calls return immediately and notify this Session when complete.",
    input: Parameters,
    output: Success,
    execute: (parameters, context) =>
      Effect.gen(function* () {
        const parent = yield* sessions.get(context.sessionID)
        const agent = yield* resolveAgent(parent.location, AgentV2.ID.make(parameters.subagent_type))
        if (!agent || (agent.mode !== "subagent" && agent.mode !== "all") || agent.hidden)
          return yield* new ToolFailure({ message: `Unknown subagent: ${parameters.subagent_type}` })
        const child = yield* sessions.create({
          parentID: parent.id,
          location: parent.location,
          agent: agent.id,
          model: agent.model ?? parent.model,
        })

        const run = Effect.gen(function* () {
          yield* sessions.prompt({
            sessionID: child.id,
            prompt: new Prompt({ text: parameters.prompt }),
            delivery: "steer",
            resume: false,
          })
          yield* sessions.resume(child.id)
          const messages = yield* sessions.messages({ sessionID: child.id, order: "desc", limit: 1 })
          const assistant = messages.find(
            (message): message is SessionMessage.Assistant => message.type === "assistant" && !!message.time.completed,
          )
          if (!assistant) return ""
          return assistant.content
            .filter((part): part is SessionMessage.AssistantText => part.type === "text")
            .map((part) => part.text)
            .join("\n")
        }).pipe(Effect.onInterrupt(() => sessions.interrupt(child.id)))

        if (parameters.background !== true) {
          const output = yield* run.pipe(
            Effect.mapError((error) => new ToolFailure({ message: `Task failed: ${String(error)}`, error })),
          )
          return { sessionID: child.id, status: "completed" as const, output }
        }

        yield* run.pipe(
          Effect.matchCauseEffect({
            onSuccess: (output) => notify("completed", output),
            onFailure: (cause) => notify("error", String(Cause.squash(cause))),
          }),
          Effect.tapCause((cause) => Effect.logError("Background task notification failed", Cause.squash(cause))),
          Effect.ignore,
          Effect.forkIn(scope, { startImmediately: true }),
        )
        return { sessionID: child.id, status: "running" as const }

        function notify(state: "completed" | "error", text: string) {
          const tag = state === "completed" ? "task_result" : "task_error"
          return sessions.prompt({
            sessionID: parent.id,
            prompt: new Prompt({
              text: `<task id="${child.id}" state="${state}">\n<summary>Background task ${state}: ${parameters.description}</summary>\n<${tag}>\n${text}\n</${tag}>\n</task>`,
            }),
            delivery: "steer",
          })
        }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure
            ? error
            : new ToolFailure({ message: `Unable to run task: ${String(error)}`, error }),
        ),
      ),
    toModelOutput: ({ output }) => [
      {
        type: "text",
        text:
          output.status === "running"
            ? `<task id="${output.sessionID}" state="running">\nThe task is working in the background. You will be notified automatically when it finishes.\n</task>`
            : `<task id="${output.sessionID}" state="completed">\n<task_result>\n${output.output ?? ""}\n</task_result>\n</task>`,
      },
    ],
  })
})
