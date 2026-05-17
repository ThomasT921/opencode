import { Config as EffectConfig, Context, Effect, Layer, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { Git } from "@/git"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import {
  FetchHttpClient,
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Account } from "@/account/account"
import { AccountRepo } from "@/account/repo"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as Observability from "@opencode-ai/core/effect/observability"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Installation } from "@/installation"
import { InstanceStore } from "@/project/instance-store"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceBootstrap } from "@/project/bootstrap"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Npm } from "@opencode-ai/core/npm"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Project } from "@/project/project"
import { ProviderAuth } from "@/provider/auth"
import { ModelsDev } from "@opencode-ai/core/models"
import { Provider } from "@/provider/provider"
import { Pty } from "@/pty"
import { PtyTicket } from "@/pty/ticket"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionProcessor } from "@/session/processor"
import { Instruction } from "@/session/instruction"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LLM } from "@/session/llm"
import { SystemPrompt } from "@/session/system"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Workspace } from "@/control-plane/workspace"
import { SimulationFileSystem } from "@/testing/simulation/filesystem"
import { SimulationNetwork } from "@/testing/simulation/network"
import { SimulationNetworkRoutes } from "@/testing/simulation/network-routes"
import { SimulationProvider } from "@/testing/simulation/provider"
import { SimulationSpawner } from "@/testing/simulation/spawner"
import { SimulationGit } from "@/testing/simulation/git"
import { Simulation } from "@/testing/simulation/service"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { InMemoryFs } from "just-bash"
import { PublicApi } from "./public"
import { authorizationLayer, authorizationRouterMiddleware } from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectRoute, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { v2Handlers } from "./handlers/v2"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer, instanceRouterMiddleware } from "./middleware/instance-context"
import { workspaceRouterMiddleware, workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { simulationRoute } from "./simulation"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes/rawInstanceRoutes: raw instance routes; auth and workspace routing happen as router middleware.
// - instanceApiRoutes: schema routes; auth is declared on each group and workspace context is provided below.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const instanceRouterLayer = authorizationRouterMiddleware
  .combine(instanceRouterMiddleware)
  .combine(workspaceRouterMiddleware)
  .layer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal), Layer.provide(ServerAuth.Config.defaultLayer))
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide(instanceRouterLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    v2Handlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const rawInstanceRoutes = Layer.mergeAll(ptyConnectRoute).pipe(Layer.provide(instanceRouterLayer))
const instanceRoutes = Layer.mergeAll(rawInstanceRoutes, instanceApiRoutes).pipe(
  Layer.provide([
    httpApiAuthLayer,
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
  ]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const simulationShareNextLayer = Layer.succeed(
  ShareNext.Service,
  ShareNext.Service.of({
    init: () => Effect.void,
    url: () => Effect.succeed("https://opncd.ai"),
    request: () =>
      Effect.succeed({
        headers: {},
        baseUrl: "https://opncd.ai",
        api: {
          create: "/api/shares",
          sync: (shareID) => `/api/shares/${shareID}/sync`,
          remove: (shareID) => `/api/shares/${shareID}`,
          data: (shareID) => `/api/shares/${shareID}/data`,
        },
      }),
    create: () => Effect.succeed({ id: "", url: "", secret: "" }),
    remove: () => Effect.void,
  }),
)

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

function createProductionRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, docRoute, uiRoute).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      Account.defaultLayer,
      Agent.defaultLayer,
      Auth.defaultLayer,
      Command.defaultLayer,
      Config.defaultLayer,
      File.defaultLayer,
      FileWatcher.defaultLayer,
      Format.defaultLayer,
      LSP.defaultLayer,
      Installation.defaultLayer,
      MCP.defaultLayer,
      ModelsDev.defaultLayer,
      Permission.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ProviderAuth.defaultLayer,
      Provider.defaultLayer,
      Pty.defaultLayer,
      PtyTicket.defaultLayer,
      Question.defaultLayer,
      Ripgrep.defaultLayer,
      RuntimeFlags.defaultLayer,
      Session.defaultLayer,
      SessionCompaction.defaultLayer,
      SessionPrompt.defaultLayer,
      SessionRevert.defaultLayer,
      SessionShare.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      SessionSummary.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      SyncEvent.defaultLayer,
      EventV2Bridge.defaultLayer,
      Skill.defaultLayer,
      Todo.defaultLayer,
      ToolRegistry.defaultLayer,
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      Worktree.appLayer,
      Bus.layer,
      AppFileSystem.defaultLayer,
      FetchHttpClient.layer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(InstanceLayer.layer),
    Layer.provide(Observability.layer),
  )
}

export function createSimulatedRoutes(corsOptions?: CorsOptions): ReturnType<typeof createProductionRoutes> {
  const fs = new InMemoryFs()

  // ────────────────────────────────────────────────────────────────────────
  // Pattern: `consumer.pipe(Layer.provideMerge(dep))` — `consumer` (LHS) CAN
  // see `dep` (RHS). We build STRICTLY bottom-up via topological sort:
  // consumers at the START of the pipe, deepest leaves at the END.
  //
  // Each tier is built and TYPE-ANNOTATED with its expected `Layer.Layer<
  // ROut, E, RIn>` so we can verify the composition is correct step by step.
  // ────────────────────────────────────────────────────────────────────────

  // ─── Tier 0: true leaves with NO app deps ───────────────────────────────
  // Provides: everything in this Layer.mergeAll. Requires: nothing.
  // (SimulationGit needs AppFileSystem; goes in tier1.)
  type Tier0Services =
    | AppFileSystem.Service
    | FileSystem.FileSystem
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
    | SimulationNetwork.Service
    | Path.Path
    | Global.Service
    | Env.Service
    | Bus.Service
    | AccountRepo.Service
    | ShareNext.Service
    | SyncEvent.Service
    | PtyTicket.Service

  const tier0: Layer.Layer<Tier0Services, never, never> = Layer.mergeAll(
    SimulationFileSystem.layer({
      root: "/opencode",
      fs,
      files: {
        ".git/HEAD": "ref: refs/heads/main\n",
        ".git/config": '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[branch "main"]\n',
      },
    }),
    // SimulationFileSystem.layer no longer provides FileSystem.FileSystem; satisfy
    // it with a no-op so nothing in the chain falls back to NodeFileSystem.
    FileSystem.layerNoop({}),
    SimulationSpawner.layer({ root: "/opencode", fs }),
    SimulationNetwork.layer({ entries: SimulationNetworkRoutes.defaults(), allowLoopback: true }),
    NodePath.layer,
    Global.layer,
    Env.layer,
    Bus.layer,
    AccountRepo.layer,
    simulationShareNextLayer,
    SyncEvent.layer,
    PtyTicket.layer,
  )

  // ─── Tier 1: services depending only on tier 0 ──────────────────────────
  // SimulationGit → AppFileSystem
  // Truncate → AppFileSystem
  // Auth → AppFileSystem
  // McpAuth → AppFileSystem
  // EffectFlock → Global, AppFileSystem
  // Permission → Bus
  // Todo → Bus
  // Question → Bus
  // SessionStatus → Bus
  // Discovery → AppFileSystem, Path, HttpClient
  // Ripgrep → AppFileSystem, HttpClient, ChildProcessSpawner
  // Account → AccountRepo, HttpClient
  const tier1: Layer.Layer<
    | Tier0Services
    | Git.Service
    | Truncate.Service
    | Auth.Service
    | McpAuth.Service
    | EffectFlock.Service
    | Permission.Service
    | Todo.Service
    | Question.Service
    | SessionStatus.Service
    | Discovery.Service
    | Ripgrep.Service
    | Account.Service,
    never,
    never
  > = Layer.mergeAll(
    SimulationGit.layer,
    Truncate.layer,
    Auth.layer,
    McpAuth.layer,
    EffectFlock.layer,
    Permission.layer,
    Todo.layer,
    Question.layer,
    SessionStatus.layer,
    Discovery.layer,
    Ripgrep.layer,
    Account.layer,
  ).pipe(Layer.provideMerge(tier0))

  type Tier1Services =
    | Tier0Services
    | Git.Service
    | Truncate.Service
    | Auth.Service
    | McpAuth.Service
    | EffectFlock.Service
    | Permission.Service
    | Todo.Service
    | Question.Service
    | SessionStatus.Service
    | Discovery.Service
    | Ripgrep.Service
    | Account.Service

  // ─── Tier 2: services depending only on tier 0 + tier 1 ─────────────────
  // Npm → AppFileSystem, Global, FileSystem, EffectFlock
  // ModelsDev → AppFileSystem, HttpClient
  // Project → AppFileSystem, Path, ChildProcessSpawner, Bus
  // Installation → HttpClient, ChildProcessSpawner
  // Storage → AppFileSystem, Git
  // Vcs → Git, Bus
  // SessionRunState → SessionStatus
  const tier2: Layer.Layer<
    | Tier1Services
    | Npm.Service
    | ModelsDev.Service
    | Project.Service
    | Installation.Service
    | Storage.Service
    | Vcs.Service
    | SessionRunState.Service,
    never,
    never
  > = Layer.mergeAll(
    Npm.layer,
    ModelsDev.layer,
    Project.layer,
    Installation.layer,
    Storage.layer,
    Vcs.layer,
    SessionRunState.layer,
  ).pipe(Layer.provideMerge(tier1))

  type Tier2Services =
    | Tier1Services
    | Npm.Service
    | ModelsDev.Service
    | Project.Service
    | Installation.Service
    | Storage.Service
    | Vcs.Service
    | SessionRunState.Service

  // ─── Tier 3: services depending only on tier 0-2 ────────────────────────
  // Config → AppFileSystem, Auth, Account, Env, Npm
  // File → AppFileSystem, Ripgrep, Git, Scope
  // Simulation → AppFileSystem, SimulationNetwork
  // Session → Bus, Storage, SyncEvent
  const tier3: Layer.Layer<
    Tier2Services | Config.Service | File.Service | Simulation.Service | Session.Service,
    never,
    never
  > = Layer.mergeAll(Config.layer, File.layer, Simulation.layer, Session.layer).pipe(Layer.provideMerge(tier2))

  type Tier3Services = Tier2Services | Config.Service | File.Service | Simulation.Service | Session.Service

  // ─── Tier 4: services depending on tier 0-3 (mostly Config) ─────────────
  // Plugin → Bus, Config
  // FileWatcher → Config, Git
  // Format → Config, ChildProcessSpawner
  // Snapshot → AppFileSystem, ChildProcessSpawner, Config
  // LSP → Config
  // MCP → ChildProcessSpawner, McpAuth, Bus, Config
  // Skill → Discovery, Config, Bus, AppFileSystem, Global
  // Instruction → Config, AppFileSystem, Global, HttpClient
  // SimulationProvider → Simulation (provides Provider tag)
  const tier4: Layer.Layer<
    | Tier3Services
    | Plugin.Service
    | FileWatcher.Service
    | Format.Service
    | Snapshot.Service
    | LSP.Service
    | MCP.Service
    | Skill.Service
    | Instruction.Service
    | Provider.Service,
    never,
    never
  > = Layer.mergeAll(
    Plugin.layer,
    FileWatcher.layer,
    Format.layer,
    Snapshot.layer,
    LSP.layer,
    MCP.layer,
    Skill.layer,
    Instruction.layer,
    SimulationProvider.layer,
  ).pipe(Layer.provideMerge(tier3))

  type Tier4Services =
    | Tier3Services
    | Plugin.Service
    | FileWatcher.Service
    | Format.Service
    | Snapshot.Service
    | LSP.Service
    | MCP.Service
    | Skill.Service
    | Instruction.Service
    | Provider.Service

  // ─── Tier 5: services depending on tier 0-4 ─────────────────────────────
  // Pty → Config, Bus, Plugin
  // ProviderAuth → Auth, Plugin
  // SessionSummary → Session, Snapshot, Storage, Bus
  // Agent → Config, Auth, Plugin, Skill, Provider
  // Command → Config, MCP, Skill
  // LLM → Auth, Config, Provider, Plugin, Permission
  // SystemPrompt → Skill
  const tier5: Layer.Layer<
    | Tier4Services
    | Pty.Service
    | ProviderAuth.Service
    | SessionSummary.Service
    | Agent.Service
    | Command.Service
    | LLM.Service
    | SystemPrompt.Service,
    never,
    never
  > = Layer.mergeAll(
    Pty.layer,
    ProviderAuth.layer,
    SessionSummary.layer,
    Agent.layer,
    Command.layer,
    LLM.layer,
    SystemPrompt.layer,
  ).pipe(Layer.provideMerge(tier4))

  type Tier5Services =
    | Tier4Services
    | Pty.Service
    | ProviderAuth.Service
    | SessionSummary.Service
    | Agent.Service
    | Command.Service
    | LLM.Service
    | SystemPrompt.Service

  // ─── Tier 6: services depending on tier 0-5 ─────────────────────────────
  // SessionRevert → Session, Snapshot, Storage, Bus, SessionSummary, SessionRunState, SyncEvent
  // SessionProcessor → Session, Config, Bus, Snapshot, Agent, LLM, Permission, Plugin,
  //                    SessionSummary, Scope, SessionStatus
  // SessionShare → Config, Session, ShareNext, SyncEvent
  const tier6: Layer.Layer<
    Tier5Services | SessionRevert.Service | SessionProcessor.Service | SessionShare.Service,
    never,
    never
  > = Layer.mergeAll(SessionRevert.layer, SessionProcessor.layer, SessionShare.layer).pipe(Layer.provideMerge(tier5))

  type Tier6Services = Tier5Services | SessionRevert.Service | SessionProcessor.Service | SessionShare.Service

  // ─── Tier 7: services depending on tier 0-6 ─────────────────────────────
  // SessionCompaction → Bus, Config, Session, Agent, Plugin, SessionProcessor, Provider
  // SessionPrompt → Bus, SessionStatus, Session, Agent, Provider, SessionProcessor,
  //                 SessionCompaction(!), Plugin, Command, Config, Permission, AppFileSystem,
  //                 MCP, LSP, ToolRegistry(!), Truncate, ChildProcessSpawner, Instruction,
  //                 SessionRunState, SessionRevert, SessionSummary, SystemPrompt, LLM
  // ToolRegistry → Config, Plugin, Agent, Skill, Truncate, Question, Todo, Session,
  //                Provider, Git, LSP, Instruction, AppFileSystem, Bus, HttpClient,
  //                ChildProcessSpawner, Ripgrep, Format
  //
  // SessionPrompt needs SessionCompaction AND ToolRegistry — so it's tier 8.
  const tier7: Layer.Layer<Tier6Services | SessionCompaction.Service | ToolRegistry.Service, never, never> =
    Layer.mergeAll(SessionCompaction.layer, ToolRegistry.layer).pipe(Layer.provideMerge(tier6))

  type Tier7Services = Tier6Services | SessionCompaction.Service | ToolRegistry.Service

  // ─── Tier 8: services depending on tier 0-7 ─────────────────────────────
  // SessionPrompt → tier 7 (SessionCompaction, ToolRegistry, etc.)
  // (Workspace needs SessionPrompt — goes to tier 9)
  const tier8: Layer.Layer<Tier7Services | SessionPrompt.Service, never, never> = Layer.mergeAll(
    SessionPrompt.layer,
  ).pipe(Layer.provideMerge(tier7))

  type Tier8Services = Tier7Services | SessionPrompt.Service

  // ─── Tier 9: Workspace + InstanceBootstrap (depend on tier 0-8) ─────────
  // Workspace → Auth, Session, SessionPrompt, HttpClient, SyncEvent, Vcs
  // InstanceBootstrap → Config, File, FileWatcher, Format, LSP, Plugin, Project,
  //                     ShareNext, Snapshot, Vcs
  const tier9: Layer.Layer<Tier8Services | Workspace.Service | InstanceBootstrap.Service, never, never> =
    Layer.mergeAll(Workspace.layer, InstanceBootstrap.layer).pipe(Layer.provideMerge(tier8))

  type Tier9Services = Tier8Services | Workspace.Service | InstanceBootstrap.Service

  // ─── Tier 10: InstanceStore + Worktree (depend on InstanceBootstrap) ────
  // InstanceStore → Project, InstanceBootstrap
  // Worktree → AppFileSystem, Path, ChildProcessSpawner, Git, Project, InstanceStore
  //            (Worktree → InstanceStore → tier 10 itself, so Worktree is tier 11)
  const tier10: Layer.Layer<Tier9Services | InstanceStore.Service, never, never> = Layer.mergeAll(
    InstanceStore.layer,
  ).pipe(Layer.provideMerge(tier9))

  type Tier10Services = Tier9Services | InstanceStore.Service

  // ─── Tier 11: Worktree (depends on InstanceStore) ───────────────────────
  const tier11: Layer.Layer<Tier10Services | Worktree.Service, never, never> = Layer.mergeAll(Worktree.layer).pipe(
    Layer.provideMerge(tier10),
  )

  // ─── Tier 12: HTTP-level middleware + platform ──────────────────────────
  // Handles Request<"Error", *>, HttpRouter, HttpPlatform, Generator, etc.
  const tier12 = Layer.mergeAll(
    errorLayer,
    compressionLayer,
    corsVaryFix,
    fenceLayer,
    cors(corsOptions),
    HttpServer.layerServices,
  ).pipe(Layer.provideMerge(tier11))

  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, docRoute, uiRoute, simulationRoute).pipe(
    Layer.provide(tier12),
    Layer.provideMerge(Layer.succeed(CorsConfig)(corsOptions)),
    // Build a simulated InstanceLayer equivalent that exposes InstanceStore.Service in
    // the result's `ROut` (matching the production layer's shape) WITHOUT pulling in
    // `InstanceLayer.layer` from `@/project/instance-layer` — that one uses
    // `InstanceStore.defaultLayer` + `InstanceBootstrap.defaultLayer` which transitively
    // pull `AppFileSystem.defaultLayer` and `NodeFileSystem.layer` into our chain.
    Layer.provideMerge(InstanceStore.layer.pipe(Layer.provide(InstanceBootstrap.layer), Layer.provide(tier9))),
    Layer.provideMerge(Observability.layer),
  )
}

export function createRoutes(corsOptions?: CorsOptions) {
  if (Flag.OPENCODE_SIMULATION_BACKEND) {
    return createSimulatedRoutes(corsOptions)
  }

  return createProductionRoutes(corsOptions)
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
