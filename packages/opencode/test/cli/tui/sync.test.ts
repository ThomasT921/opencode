import { describe, expect, test } from "bun:test"
import type { QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { questionToolRequestIndex } from "@/cli/cmd/tui/context/sync"

const request = {
  id: "question-new",
  sessionID: "session-1",
  questions: [],
  tool: { messageID: "msg-new", callID: "call-new" },
} satisfies QuestionRequest

function part(status: "running" | "completed" | "error", tool = "question", callID = "call-new"): ToolPart {
  return {
    id: "part-new",
    sessionID: "session-1",
    messageID: "msg-new",
    type: "tool",
    callID,
    tool,
    state:
      status === "running"
        ? { status, input: {}, time: { start: 1 } }
        : status === "completed"
          ? { status, input: {}, output: "", title: "question", metadata: {}, time: { start: 1, end: 2 } }
          : { status, input: {}, error: "Tool execution aborted", time: { start: 1, end: 2 } },
  }
}

describe("tui sync", () => {
  test("matches terminal tool-owned question requests", () => {
    const stale = { ...request, id: "question-old", tool: { messageID: "msg-old", callID: "call-old" } }

    expect(questionToolRequestIndex([stale, request], part("error"))).toBe(1)
    expect(questionToolRequestIndex([stale, request], part("completed"))).toBe(1)
    expect(questionToolRequestIndex([stale, request], part("completed", "plan_exit"))).toBe(1)
    expect(questionToolRequestIndex([stale, request], part("running"))).toBe(-1)
    expect(questionToolRequestIndex([stale, request], part("error", "bash", "call-other"))).toBe(-1)
  })
})
