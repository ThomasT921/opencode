# opencode

The runtime that powers the opencode CLI/TUI: it manages projects on disk, runs
agent sessions against LLM providers, and exposes a control plane so other
clients (web, IDE, remote workspaces) can connect to the same state.

## Language

### Location & runtime

**Project**:
The persisted, VCS-rooted thing the user owns — one row per repo (or per non-VCS directory).
_Avoid_: repo, codebase, folder

**Worktree**:
A git worktree of a **Project** — a branch checkout sitting at a directory on disk.
_Avoid_: branch dir, checkout, workspace

**Workspace**:
A control-plane connection target for a **Project**, identified by a `wrk_…` ID. Local or remote. Describes _how_ a client is connected to a Project, not where the Project lives on disk.
_Avoid_: worktree, session, project (the connection is not the project itself)

**Instance**:
The runtime `(project, worktree, directory)` ALS context the opencode process is currently operating inside. Not persisted; not user-visible.
_Avoid_: session, context, runtime

**Directory**:
A filesystem path string. The Instance always has one as its current working directory.
_Avoid_: folder, cwd (in domain prose; fine in code)

## Relationships

- A **Project** has zero or more **Worktrees**.
- A **Worktree** belongs to exactly one **Project**.
- A **Workspace** points at exactly one **Project** (and optionally a specific branch/directory inside it).
- An **Instance** is bound to one **Project**, one **Worktree**, and one **Directory** for the life of an async context.

## Example dialogue

> **Dev:** "When the user opens a remote target, do we create a new **Worktree**?"
> **Maintainer:** "No — a remote target is a **Workspace** pointing at a **Project** on the other side. The remote host already has its own **Worktrees**; we just connect to one."

## Flagged ambiguities

- "workspace" was used in `src/project/project.ts` to mean **Worktree** ("Startup script to run when creating a new workspace (worktree)") — resolved: these are distinct. The start command runs when creating a **Worktree**, not a **Workspace**.
