import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { app, BrowserWindow, dialog } from "electron"
import pkg from "electron-updater"
import { Data, Deferred, Effect, Fiber, Option, PubSub, Queue, Ref, Stream, SubscriptionRef } from "effect"

import contextMenu from "electron-context-menu"
contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

// on macOS apps run in `/` which can cause issues with ripgrep
try {
  process.chdir(homedir())
} catch {}

process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
app.setAppUserModelId(appId)
app.setPath("userData", join(app.getPath("appData"), appId))
const { autoUpdater } = pkg

import { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import type { Server } from "virtual:opencode-server"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServerEffect } from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"

// ---------------------------------------------------------------------------
// State — individual pieces, synchronously allocated at module load.
// ---------------------------------------------------------------------------

const initStep = Effect.runSync(SubscriptionRef.make<InitStep>(InitStep.ServerWaiting()))
const serverReady = Deferred.makeUnsafe<ServerReadyData>()
const loadingComplete = Deferred.makeUnsafe<void>()
const deepLinkQueue = Effect.runSync(Queue.unbounded<string[]>())
const deepLinksConsumed = Deferred.makeUnsafe<void>()
const server = Ref.makeUnsafe<Option.Option<Server.Listener>>(Option.none())
const menuCommands = Effect.runSync(PubSub.unbounded<string>())
const sqliteProgress = Effect.runSync(PubSub.unbounded<SqliteMigrationProgress>())

// ---------------------------------------------------------------------------
// App events (Data.TaggedEnum)
// ---------------------------------------------------------------------------

type AppEvent = Data.TaggedEnum<{
  SecondInstance: { readonly argv: readonly string[] }
  OpenUrl: { readonly url: string }
  BeforeQuit: {}
  WillQuit: {}
}>

const appEvent = Data.taggedEnum<AppEvent>()

const handleAppEvent = (
  event: AppEvent,
  deepLinkQueue: Queue.Queue<string[]>,
  mainWindow: BrowserWindow,
  server: Ref.Ref<Option.Option<Server.Listener>>,
) =>
  appEvent.$match(event, {
    SecondInstance: ({ argv }) =>
      Effect.gen(function* () {
        const urls = argv.filter((arg) => arg.startsWith("opencode://"))
        if (urls.length) {
          logger.log("deep link received via second-instance", { urls })
          yield* Queue.offer(deepLinkQueue, urls)
        }
        focusMainWindow(mainWindow)
      }),
    OpenUrl: ({ url }) =>
      Effect.gen(function* () {
        logger.log("deep link received via open-url", { url })
        yield* Queue.offer(deepLinkQueue, [url])
      }),
    BeforeQuit: () => stopServer(server),
    WillQuit: () => stopServer(server),
  })

// ---------------------------------------------------------------------------
// Pure state helpers (explicit parameters — no hidden closures)
// ---------------------------------------------------------------------------

const focusMainWindow = (win: BrowserWindow) => {
  win.show()
  win.focus()
}

const stopServer = (ref: Ref.Ref<Option.Option<Server.Listener>>) =>
  Effect.gen(function* () {
    const srv = yield* Ref.get(ref)
    if (Option.isSome(srv)) {
      yield* Effect.promise(() => srv.value.stop())
      yield* Ref.set(ref, Option.none())
    }
  })

const initialize = Effect.fn("Main.initialize")(function* () {
  const needsMigration = !sqliteFileExists()

  const port = yield* getSidecarPort
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingFiber = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    if (needsMigration) {
      const { Database, JsonMigration } = yield* Effect.promise(
        () => import("virtual:opencode-server") as Promise<typeof import("virtual:opencode-server")>,
      )
      const client = Database.Client().$client
      const db = yield* Effect.promise(() =>
        import("drizzle-orm/node-sqlite/driver").then((m) => m.drizzle({ client })),
      )

      yield* SubscriptionRef.set(initStep, InitStep.SqliteWaiting())

      yield* Effect.promise(() =>
        JsonMigration.run(db, {
          progress: (event: { current: number; total: number }) => {
            const percent = Math.round((event.current / event.total) * 100)
            const progress: SqliteMigrationProgress = { type: "InProgress", value: percent }
            if (Option.isSome(overlay)) sendSqliteMigrationProgress(overlay.value, progress)
            void Effect.runPromise(PubSub.publish(sqliteProgress, progress))
          },
        }),
      )

      yield* PubSub.publish(sqliteProgress, { type: "Done" })
    }

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* spawnLocalServerEffect(hostname, port, password)
    yield* Ref.set(server, Option.some(listener))

    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    yield* Effect.raceAll([
      health,
      Effect.sleep("30 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error("Sidecar health check timed out")))),
    ]).pipe(Effect.catch((error) => Effect.sync(() => logger.error("sidecar health check failed", error))))

    logger.log("loading task finished")

    return listener
  }).pipe(Effect.forkChild)

  const overlay = yield* Effect.gen(function* () {
    if (!needsMigration) return

    const show = yield* Effect.raceAll([
      Fiber.join(loadingFiber).pipe(Effect.as(false)),
      Effect.sleep("1 second").pipe(Effect.as(true)),
    ])
    if (!show) return

    const overlay = createLoadingWindow()
    yield* Effect.sleep("1 second")
    return overlay
  }).pipe(Effect.map(Option.fromNullishOr))

  yield* Fiber.join(loadingFiber)
  yield* SubscriptionRef.set(initStep, InitStep.Done())

  if (Option.isSome(overlay)) {
    yield* Deferred.await(loadingComplete)
    overlay.value.close()
  }
})

// ---------------------------------------------------------------------------
// App lifecycle (imperative Electron shell, thin wrappers around Effects)
// ---------------------------------------------------------------------------

const logger = initLogging()

const shutdown = Effect.gen(function* () {
  yield* stopServer(server)
  app.exit(0)
})

const registerAppEventListeners = (appEvents: PubSub.PubSub<AppEvent>) => () => {
  app.on("second-instance", (_event, argv) => {
    PubSub.publishUnsafe(appEvents, appEvent.SecondInstance({ argv }))
  })

  app.on("open-url", (event, url) => {
    event.preventDefault()
    PubSub.publishUnsafe(appEvents, appEvent.OpenUrl({ url }))
  })

  app.on("before-quit", () => {
    PubSub.publishUnsafe(appEvents, appEvent.BeforeQuit())
  })

  app.on("will-quit", () => {
    PubSub.publishUnsafe(appEvents, appEvent.WillQuit())
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void Effect.runPromise(shutdown)
    })
  }
}

const ensureLoopbackNoProxy = () => {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
  })

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  const appEvents = yield* PubSub.unbounded<AppEvent>()
  registerAppEventListeners(appEvents)

  yield* Effect.promise(() => app.whenReady())

  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()

  registerIpcHandlersImpl()

  yield* initialize()

  const mainWindow = createMainWindow()
  wireMenu(mainWindow)

  yield* Effect.all(
    [
      Stream.fromPubSub(appEvents).pipe(
        Stream.runForEach((event) => handleAppEvent(event, deepLinkQueue, mainWindow, server)),
      ),
      Deferred.await(deepLinksConsumed).pipe(
        Effect.andThen(
          Stream.fromQueue(deepLinkQueue).pipe(
            Stream.runForEach((urls) => Effect.sync(() => sendDeepLinks(mainWindow, urls))),
          ),
        ),
      ),
      Stream.fromPubSub(menuCommands).pipe(
        Stream.runForEach((id) => Effect.sync(() => sendMenuCommand(mainWindow, id))),
      ),
    ],
    { concurrency: "unbounded" },
  )
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      logger.error("initialization failed", error)
      app.exit(1)
    }),
  ),
)

void Effect.runPromise(main)

const wireMenu = (win: BrowserWindow) => {
  createMenu({
    trigger: (id) => {
      sendMenuCommand(win, id)
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => win.reload(),
    relaunch: () => {
      void Effect.runPromise(
        Effect.gen(function* () {
          yield* stopServer(server)
          app.relaunch()
          app.exit(0)
        }),
      )
    },
  })
}

const registerIpcHandlersImpl = () =>
  registerIpcHandlers({
    killSidecar: () => Effect.runPromise(stopServer(server)),
    awaitInitialization: (sendStep) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const currentStep = yield* SubscriptionRef.get(initStep)
          sendStep(currentStep)

          yield* SubscriptionRef.changes(initStep).pipe(
            Stream.runForEach((step) => Effect.sync(() => sendStep(step))),
            Effect.forkScoped,
          )

          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })

          return res
        }).pipe(Effect.scoped),
      ),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () =>
      Effect.runPromise(
        Queue.clear(deepLinkQueue).pipe(
          Effect.map((links) => links.flat()),
          Effect.tap(() => Deferred.succeed(deepLinksConsumed, undefined)),
        ),
      ),
    getDefaultServerUrl: () => Effect.runPromise(getDefaultServerUrl),
    setDefaultServerUrl: (url) => Effect.runPromise(setDefaultServerUrl(url)),
    getWslConfig: () => Effect.runPromise(getWslConfig),
    setWslConfig: (config: WslConfig) => Effect.runPromise(setWslConfig(config)),
    getDisplayBackend: () => Promise.resolve(null),
    setDisplayBackend: () => Promise.resolve(undefined),
    parseMarkdown: (markdown) => Promise.resolve(parseMarkdown(markdown)),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: (path, mode) => Promise.resolve(wslPath(path, mode)),
    resolveAppPath: (appName) => Promise.resolve(resolveAppPath(appName)),
    loadingWindowComplete: () => Effect.runPromise(Deferred.succeed(loadingComplete, undefined)),
    runUpdater: (alertOnFail) => checkForUpdates(alertOnFail),
    checkUpdate: () => checkUpdate(),
    installUpdate: () => installUpdate(),
    setBackgroundColor,
  })

const getSidecarPort = Effect.gen(function* () {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  const deferred = yield* Deferred.make<number, string>()

  const server = createServer()
  server.on("error", (e) => Deferred.failSync(deferred, () => e.toString()))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || !address) {
      server.close()
      Deferred.failSync(deferred, () => "Failed to get port")
      return
    }
    const port = address.port
    server.close(() => Effect.runSync(Deferred.succeed(deferred, port)))
  })

  return yield* Deferred.await(deferred)
})

const sqliteFileExists = () => {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

let downloadedUpdateVersion: string | undefined

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  if (downloadedUpdateVersion) {
    logger.log("returning cached downloaded update", {
      version: downloadedUpdateVersion,
    })
    return { updateAvailable: true, version: downloadedUpdateVersion }
  }
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    logger.log("update available", { version })
    await autoUpdater.downloadUpdate()
    logger.log("update download completed", { version })
    downloadedUpdateVersion = version
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

async function installUpdate() {
  if (!downloadedUpdateVersion) {
    logger.log("install update skipped", {
      reason: "no downloaded update ready",
    })
    return
  }
  logger.log("installing downloaded update", {
    version: downloadedUpdateVersion,
  })
  void Effect.runPromise(stopServer(server))
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}
