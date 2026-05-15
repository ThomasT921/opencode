import type { CliRenderer, Renderable } from "@opentui/core"

export interface MockInput {
  readonly typeText: (text: string) => Promise<void>
  readonly pressKey: (key: string, modifiers?: KeyModifiers) => void
  readonly pressEnter: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
}

export interface KeyModifiers {
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly hyper?: boolean
}

export interface MockMouse {
  readonly click: (x: number, y: number) => Promise<void>
}

export interface Harness {
  readonly renderer: CliRenderer
  readonly mockInput: MockInput
  readonly mockMouse: MockMouse
  readonly renderOnce: () => Promise<void>
}

export interface Element {
  readonly id: string
  readonly num: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly focusable: boolean
  readonly focused: boolean
  readonly clickable: boolean
  readonly editor: boolean
}

export type Action =
  | { readonly type: "typeText"; readonly text: string }
  | { readonly type: "pressKey"; readonly key: string; readonly modifiers?: KeyModifiers }
  | { readonly type: "pressEnter" }
  | { readonly type: "pressArrow"; readonly direction: "up" | "down" | "left" | "right" }
  | { readonly type: "focus"; readonly target: number }
  | { readonly type: "click"; readonly target: number; readonly x: number; readonly y: number }

function children(renderable: Renderable) {
  return renderable.getChildren().filter((child): child is Renderable => "num" in child)
}

function all(renderable: Renderable): Renderable[] {
  return [renderable, ...children(renderable).flatMap(all)]
}

function mouseListeners(renderable: Renderable) {
  const general = Reflect.get(renderable, "_mouseListener")
  const specific = Reflect.get(renderable, "_mouseListeners")
  return Boolean(general) || (specific && typeof specific === "object" && Object.keys(specific).length > 0)
}

function hit(renderer: CliRenderer, renderable: Renderable) {
  if (renderable.width <= 0 || renderable.height <= 0) return false
  const x = Math.floor(renderable.screenX + renderable.width / 2)
  const y = Math.floor(renderable.screenY + renderable.height / 2)
  return renderer.hitTest(x, y) === renderable.num
}

export function elements(renderer: CliRenderer): Element[] {
  return all(renderer.root)
    .filter((renderable) => renderable.visible && !renderable.isDestroyed)
    .map((renderable) => {
      const clickable = mouseListeners(renderable) && hit(renderer, renderable)
      return {
        id: renderable.id,
        num: renderable.num,
        x: renderable.screenX,
        y: renderable.screenY,
        width: renderable.width,
        height: renderable.height,
        focusable: renderable.focusable,
        focused: renderable.focused,
        clickable,
        editor: renderer.currentFocusedEditor === renderable,
      } satisfies Element
    })
    .filter((element) => element.focusable || element.clickable || element.editor)
}

export function actions(renderer: CliRenderer, options: { text?: string } = {}): Action[] {
  const result: Action[] = []
  const items = elements(renderer)
  if (renderer.currentFocusedEditor) {
    result.push({ type: "typeText", text: options.text ?? "hello" }, { type: "pressEnter" })
  }
  result.push(...items.filter((item) => item.focusable && !item.focused).map((item) => ({ type: "focus" as const, target: item.num })))
  result.push(
    ...items
      .filter((item) => item.clickable)
      .map((item) => ({
        type: "click" as const,
        target: item.num,
        x: Math.floor(item.x + item.width / 2),
        y: Math.floor(item.y + item.height / 2),
      })),
  )
  result.push(
    { type: "pressArrow", direction: "down" },
    { type: "pressArrow", direction: "up" },
  )
  return result
}

export async function execute(harness: Harness, action: Action) {
  switch (action.type) {
    case "typeText":
      await harness.mockInput.typeText(action.text)
      break
    case "pressKey":
      harness.mockInput.pressKey(action.key, action.modifiers)
      break
    case "pressEnter":
      harness.mockInput.pressEnter()
      break
    case "pressArrow":
      harness.mockInput.pressArrow(action.direction)
      break
    case "focus": {
      const renderable = all(harness.renderer.root).find((item) => item.num === action.target)
      renderable?.focus()
      break
    }
    case "click":
      await harness.mockMouse.click(action.x, action.y)
      break
  }
  await harness.renderOnce()
}

export * as SimulationActions from "./actions"
