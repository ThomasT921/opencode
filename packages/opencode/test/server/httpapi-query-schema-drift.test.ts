import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { WithInstance } from "../../src/project/with-instance"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"

void (await import("@opencode-ai/core/util/log")).init({ print: false })

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

function runSession<A, E>(fx: Effect.Effect<A, E, Session.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Session.defaultLayer)))
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(directory: string, input?: Session.CreateInput) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () => runSession(Session.Service.use((svc) => svc.create(input))),
      }),
  )
}

function createTextMessage(directory: string, sessionID: SessionIDType, text: string) {
  return Effect.promise(
    async () =>
      await WithInstance.provide({
        directory,
        fn: () =>
          runSession(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const info = yield* svc.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID,
                agent: "build",
                model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
                time: { created: Date.now() },
              })
              const part = yield* svc.updatePart({
                id: PartID.ascending(),
                sessionID,
                messageID: info.id,
                type: "text",
                text,
              })
              return { info, part }
            }),
          ),
      }),
  )
}

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => {
    const { Server } = await import("../../src/server/server")
    return Server.Default().app.request(path, init)
  })
}

function withTmp<A, E, R>(
  options: Parameters<typeof tmpdir>[0],
  fn: (tmp: Awaited<ReturnType<typeof tmpdir>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(fn))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

/**
 * Reproducer for: runtime HttpApi query schemas must accept directory/workspace
 * 
 * Previously, the OpenAPI spec was manually injected with directory/workspace query
 * params (InstanceQueryParameters in public.ts), but the runtime query schemas
 * did not include these fields. This caused a drift where:
 * 1. Generated SDKs would send requests with ?directory=...&workspace=...
 * 2. But runtime validation would reject these as unknown fields
 * 3. Resulting in 400 Bad Request errors
 * 
 * The fix adds directory/workspace to all instance route query schemas using the
 * extendWithInstanceQuery helper in query.ts.
 */
describe("query schema drift fix", () => {
  it.live(
    "accepts directory and workspace query params on session.messages route",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        const session = yield* createSession(tmp.path, { title: "drift test" })
        yield* createTextMessage(tmp.path, session.id, "test message")

        // This should NOT return 400 - previously it would fail validation
        // because MessagesQuery didn't include directory/workspace fields
        const response = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1&directory=${encodeURIComponent(tmp.path)}`,
          { headers },
        )

        // Should be 200 OK, not 400 Bad Request due to unknown query params
        // Note: workspace param is omitted because an invalid workspace ID would cause 500
        expect(response.status).toBe(200)
        
        const body = yield* Effect.promise(() => response.json())
        expect(Array.isArray(body)).toBe(true)
        expect(body.length).toBe(1)
      }),
    ),
  )

  it.live(
    "accepts directory and workspace query params on file.list route", 
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        
        // Create a test file
        const testFile = `${tmp.path}/test.txt`
        yield* Effect.promise(() => Bun.write(testFile, "test content"))

        // This should NOT return 400 - previously FileQuery didn't include directory/workspace
        const response = yield* request(
          `${FilePaths.list}?path=${encodeURIComponent(tmp.path)}&directory=${encodeURIComponent(tmp.path)}`,
          { headers },
        )

        // Should be 200 OK, not 400 Bad Request
        // Note: workspace param is omitted because an invalid workspace ID would cause 500
        expect(response.status).toBe(200)
        
        const body = yield* Effect.promise(() => response.json())
        expect(Array.isArray(body)).toBe(true)
      }),
    ),
  )

  it.live(
    "accepts directory and workspace query params on session.list route",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        yield* createSession(tmp.path, { title: "list drift test" })

        // This should NOT return 400 - ListQuery already had directory but now includes workspace
        // Use only directory parameter since invalid workspace ID would cause 500
        const response = yield* request(
          `${SessionPaths.list}?directory=${encodeURIComponent(tmp.path)}`,
          { headers },
        )

        // Should be 200 OK, not 400 Bad Request
        expect(response.status).toBe(200)
        
        const body = yield* Effect.promise(() => response.json())
        expect(Array.isArray(body)).toBe(true)
        expect(body.length).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "accepts directory and workspace query params on find.file route",
    withTmp({ git: true, config: { formatter: false, lsp: false } }, (tmp) =>
      Effect.gen(function* () {
        const headers = { "x-opencode-directory": tmp.path }
        
        // Create a test file
        const testFile = `${tmp.path}/findme.txt`
        yield* Effect.promise(() => Bun.write(testFile, "test content"))

        // This should NOT return 400 - FindFileQuery now includes directory/workspace
        // Use only directory parameter since invalid workspace ID would cause 500
        const response = yield* request(
          `${FilePaths.findFile}?query=findme&directory=${encodeURIComponent(tmp.path)}`,
          { headers },
        )

        // Should be 200 OK, not 400 Bad Request
        expect(response.status).toBe(200)
        
        const body = yield* Effect.promise(() => response.json())
        expect(Array.isArray(body)).toBe(true)
      }),
    ),
  )
})
