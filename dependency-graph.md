# Effect Service Dependency Graph — Simulated Routes

Generated for `createSimulatedRoutes` in `packages/opencode/src/server/routes/instance/httpapi/server.ts`.

## Notation

- `→ X` means "yields `X.Service` from its `Effect.gen` body"
- `(lazy)` means "uses `InstanceState.context` or similar at call time, not at layer construction"
- `(opt)` means "uses `Effect.serviceOption(X)` — not strictly required"

## Service → Dependencies

```
─── External / Platform ─────────────────────────────────────────
NodePath                   (no app deps)            provides Path.Path
HttpClient (FetchHttp)     (no app deps)            provides HttpClient.HttpClient
HttpServer.layerServices   (no app deps)
ChildProcessSpawner        (from SimulationSpawner) (no app deps)

─── Leaf services (no app deps) ─────────────────────────────────
Global                     (no app deps)
Env                        (no app deps)
Bus                        (lazy via InstanceState)
SyncEvent                  (lazy via InstanceState)
AccountRepo                (uses Database directly)
PtyTicket                  (Cache only)
Truncate                   → AppFileSystem (+ Config opt)

─── Middleware/route layers (no app service deps) ───────────────
errorLayer
compressionLayer           → HttpServerRequest (builtin)
corsVaryFix
fenceLayer                 → HttpServerRequest (builtin)
runtime
simulationShareNextLayer   provides ShareNext (Layer.succeed override)

─── Simulation overrides ────────────────────────────────────────
simulationBoundary:
  SimulationFileSystem     provides AppFileSystem + FileSystem.FileSystem(noop)
  SimulationSpawner        provides ChildProcessSpawner
  SimulationNetwork        provides SimulationNetwork.Service + HttpClient
                           (httpClientLayer → SimulationNetwork)

SimulationGit              → AppFileSystem               (overrides Git tag)
SimulationProvider         → Simulation                  (overrides Provider tag)
Simulation                 → AppFileSystem, SimulationNetwork

─── Core services ───────────────────────────────────────────────
EffectFlock                → Global, AppFileSystem
Auth                       → AppFileSystem
Account                    → AccountRepo, HttpClient
Npm                        → AppFileSystem, Global, FileSystem.FileSystem, EffectFlock
Config                     → AppFileSystem, Auth, Account, Env, Npm
Permission                 → Bus
Plugin                     → Bus, Config
Discovery                  → AppFileSystem, Path, HttpClient
Skill                      → Discovery, Config, Bus, AppFileSystem, Global
SystemPrompt               → Skill

─── File / git ──────────────────────────────────────────────────
Ripgrep                    → AppFileSystem, HttpClient, ChildProcessSpawner
File                       → AppFileSystem, Ripgrep, Git, Scope
FileWatcher                → Config, Git
Format                     → Config, ChildProcessSpawner
Snapshot                   → AppFileSystem, ChildProcessSpawner, Config
Storage                    → AppFileSystem, Git
Vcs                        → Git, Bus, Scope
Worktree                   → Scope, AppFileSystem, Path, ChildProcessSpawner,
                              Git, Project, InstanceStore
Project                    → AppFileSystem, Path, ChildProcessSpawner, Bus

─── Provider / LSP / MCP ────────────────────────────────────────
ModelsDev                  → AppFileSystem, HttpClient
ProviderAuth               → Auth, Plugin
LSP                        → Config
McpAuth                    → AppFileSystem
MCP                        → ChildProcessSpawner, McpAuth, Bus, Config

─── Session graph ───────────────────────────────────────────────
Todo                       → Bus
Question                   → Bus
SessionStatus              → Bus
SessionRunState            → SessionStatus
Instruction                → Config, AppFileSystem, Global, HttpClient

Session                    → Bus, Storage, SyncEvent
SessionSummary             → Session, Snapshot, Storage, Bus

SessionRevert              → Session, Snapshot, Storage, Bus,
                              SessionSummary, SessionRunState, SyncEvent
LLM                        → Auth, Config, Provider, Plugin, Permission

Agent                      → Config, Auth, Plugin, Skill, Provider
Command                    → Config, MCP, Skill

SessionProcessor           → Session, Config, Bus, Snapshot, Agent, LLM,
                              Permission, Plugin, SessionSummary, Scope,
                              SessionStatus
SessionCompaction          → Bus, Config, Session, Agent, Plugin,
                              SessionProcessor, Provider
SessionPrompt              → Bus, SessionStatus, Session, Agent, Provider,
                              SessionProcessor, SessionCompaction, Plugin,
                              Command, Config, Permission, AppFileSystem,
                              MCP, LSP, ToolRegistry, Truncate,
                              ChildProcessSpawner, Scope, Instruction,
                              SessionRunState, SessionRevert,
                              SessionSummary, SystemPrompt, LLM

ToolRegistry               → Config, Plugin, Agent, Skill, Truncate (+ many
                              tool deps: Question, Todo, Session, Provider,
                              Git, LSP, Instruction, AppFileSystem, Bus,
                              HttpClient, ChildProcessSpawner, Ripgrep,
                              Format, Truncate)

─── Share / Workspace ───────────────────────────────────────────
ShareNext                  (provided by simulationShareNextLayer in sim)
SessionShare               → Config, Session, ShareNext, Scope, SyncEvent
Workspace                  → Auth, Session, SessionPrompt, HttpClient,
                              SyncEvent, Vcs
                              (also uses InstanceStore/Bootstrap via
                               Effect.provide inside runInWorkspace)

─── Misc ────────────────────────────────────────────────────────
Installation               → HttpClient, ChildProcessSpawner
Pty                        → Config, Bus, Plugin

─── Instance lifecycle ──────────────────────────────────────────
InstanceBootstrap          → Config, File, FileWatcher, Format, LSP, Plugin,
                              Project, ShareNext, Snapshot, Vcs
InstanceStore              → Project, InstanceBootstrap, Scope

Observability              (no app deps; provides Logger + tracer)
```

## Dependency Tiers (topological order)

Roughly, build order from leaves to roots:

```
Tier 0 (no deps):
  Global, Env, NodePath, AccountRepo, PtyTicket, Bus (lazy),
  SyncEvent (lazy), AppFileSystem (sim), ChildProcessSpawner (sim),
  HttpClient (sim), SimulationNetwork, errorLayer, compressionLayer,
  corsVaryFix, fenceLayer, runtime, simulationShareNextLayer

Tier 1:
  Auth, Truncate, EffectFlock, Permission, Todo, Question,
  SessionStatus, McpAuth, Discovery, SimulationGit, Simulation,
  Ripgrep, Storage, Vcs

Tier 2:
  Account, Npm, LSP, Skill, SessionRunState, ModelsDev, File,
  Project, Worktree (needs InstanceStore — cycle hint), MCP,
  Installation, Pty, SystemPrompt

Tier 3:
  Config, FileWatcher, Format, Snapshot, ProviderAuth, Session,
  SessionShare, SessionSummary

Tier 4:
  Plugin, Agent, Command, LLM, SessionRevert,
  SimulationProvider (= Provider)

Tier 5:
  SessionProcessor, SessionCompaction, Workspace

Tier 6:
  SessionPrompt, ToolRegistry

Tier 7:
  InstanceBootstrap (needs many of the above)

Tier 8:
  InstanceStore (needs InstanceBootstrap + Project)
```

## Potential cycles / hazards

```
Worktree → InstanceStore → InstanceBootstrap → Project → (back to Worktree?)
  - InstanceBootstrap requires Project (yes)
  - Project does NOT require Worktree directly
  - Worktree requires InstanceStore — only used inside its methods,
    but yielded at layer init, so it's a true requirement
  → Worktree must be built AFTER InstanceStore.

SimulationProvider provides Provider tag, depends on Simulation.
  Many downstream services depend on Provider — those resolve to
  SimulationProvider in this layer chain.

SimulationGit provides Git tag, used by File, FileWatcher,
  Storage, Vcs, Worktree, ToolRegistry tools, Project (no — Project
  uses ChildProcessSpawner instead).

LLM.layer pipes Layer.provide(Permission.defaultLayer) internally.
  That means LLM brings its own Permission — beware double-providing
  Permission (sim chain also provides Permission.layer separately).
```

## Why the simulated chain fails with stepwise `provideMerge`

`Layer.provideMerge(self, that)` builds `that` independently and uses it to satisfy `self`'s reqs. `that` cannot see services already provided inside `self`. So when you write:

```ts
withCoreAppServices                       // contains Config.layer, Plugin.layer, ...
  .pipe(Layer.provideMerge(Npm.layer))    // Npm needs EffectFlock
```

`Npm.layer` is built in isolation and its `EffectFlock` requirement must be filled from OUTSIDE the entire pipe — not from inside `withCoreAppServices`. Same for every other "consumer added later" combination.

Production avoids this because every service is added via `Layer.provide([... defaultLayer, defaultLayer, ...])` — flat mergeAll of self-contained layers, all visible to each other.

## See also

- `dependency-graph.html` — interactive visualization of the same data.
