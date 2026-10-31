import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial } from "../utils/adb.js"

export interface UiElement {
  text: string
  resourceId: string
  className: string
  contentDesc: string
  bounds: string
  tapX: number
  tapY: number
  clickable: boolean
}

export interface UiSelector {
  text?: string
  resourceId?: string
  className?: string
  contentDesc?: string
}

export function parseUiNodes(xml: string): UiElement[] {
  const elements: UiElement[] = []
  const nodeRegex = /<node\s([^>]+?)(?:\/>|>)/gs
  let match: RegExpExecArray | null

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1]
    const attr = (name: string): string => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`) )
      return m ? m[1] : ""
    }

    const bounds = attr("bounds")
    const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!boundsMatch) continue

    const x1 = parseInt(boundsMatch[1], 10)
    const y1 = parseInt(boundsMatch[2], 10)
    const x2 = parseInt(boundsMatch[3], 10)
    const y2 = parseInt(boundsMatch[4], 10)

    elements.push({
      text: attr("text"),
      resourceId: attr("resource-id"),
      className: attr("class"),
      contentDesc: attr("content-desc"),
      bounds,
      tapX: Math.round((x1 + x2) / 2),
      tapY: Math.round((y1 + y2) / 2),
      clickable: attr("clickable") === "true",
    })
  }

  return elements
}

export function hasSelector(selector: UiSelector): boolean {
  return Boolean(selector.text || selector.resourceId || selector.className || selector.contentDesc)
}

export function matchesSelector(element: UiElement, selector: UiSelector): boolean {
  if (selector.text && !element.text.toLowerCase().includes(selector.text.toLowerCase())) {
    return false
  }
  if (selector.resourceId && element.resourceId !== selector.resourceId) {
    return false
  }
  if (selector.className && element.className !== selector.className) {
    return false
  }
  if (selector.contentDesc) {
    const needle = selector.contentDesc.toLowerCase()
    if (!element.contentDesc.toLowerCase().includes(needle)) {
      return false
    }
  }
  return true
}

export function matchElements(elements: UiElement[], selector: UiSelector): UiElement[] {
  return elements.filter((element) => matchesSelector(element, selector))
}

async function dumpUiXml(serial: string): Promise<string> {
  const tmpPath = `/sdcard/.ui_dump_${Date.now()}_${Math.random().toString(36).slice(2)}.xml`
  const raw = await execAdbShell(
    serial,
    `uiautomator dump --compressed ${tmpPath} 2>/dev/null; cat ${tmpPath}; rm -f ${tmpPath}`
  )
  // Strip the trailing status line uiautomator appends (e.g. "UI hierchary dumped to: ...")
  return raw.replace(/UI hier[^\n]*dumped to:[^\n]*/gi, "").trim()
}

const uiElementSchema = z.object({
  text: z.string().describe("Visible text of the element"),
  resourceId: z.string().describe("Resource ID of the element"),
  className: z.string().describe("Widget class name"),
  contentDesc: z.string().describe("Content description (accessibility label)"),
  bounds: z.string().describe("Raw bounds string [x1,y1][x2,y2]"),
  tapX: z.number().int().describe("X coordinate of the element center"),
  tapY: z.number().int().describe("Y coordinate of the element center"),
  clickable: z.boolean().describe("Whether the element is clickable"),
})

function errorResponse(message: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: true, message }),
    }],
    isError: true as const,
  }
}

export function registerUiTools(server: McpServer): void {
  server.registerTool(
    "ui_dump",
    {
      description: "Dump the full UI hierarchy of the current screen as XML. Useful for understanding screen structure before using ui_find_element.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        xml: z.string().describe("The UI hierarchy as a uiautomator XML document"),
      },
      annotations: {
        title: "Dump UI Hierarchy",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)
        const xml = await dumpUiXml(s)
        return {
          content: [{ type: "text", text: xml }],
          structuredContent: { xml },
        }
      } catch (error) {
        const err = error as Error
        return errorResponse(err.message)
      }
    }
  )

  server.registerTool(
    "ui_find_element",
    {
      description: "Find UI elements on screen by text, resource ID, class name, or content description. Returns matching elements with their tap coordinates. At least one search criterion must be provided.",
      inputSchema: {
        text: z.string().optional().describe("Text content to search for (partial match, case-insensitive)"),
        resourceId: z.string().optional().describe("Resource ID to match exactly (e.g., 'com.app:id/button')"),
        className: z.string().optional().describe("Class name to match exactly (e.g., 'android.widget.Button')"),
        contentDesc: z.string().optional().describe("Content description to search for (partial match, case-insensitive)"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        count: z.number().int().describe("Number of matching elements"),
        elements: z.array(uiElementSchema).describe("Matching UI elements with tap coordinates"),
      },
      annotations: {
        title: "Find UI Element",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ text, resourceId, className, contentDesc, serial }) => {
      try {
        if (!hasSelector({ text, resourceId, className, contentDesc })) {
          return errorResponse("At least one search criterion must be provided")
        }

        const s = await resolveSerial(serial)
        const xml = await dumpUiXml(s)
        const selector = { text, resourceId, className, contentDesc }
        const results = matchElements(parseUiNodes(xml), selector)

        const structured = { count: results.length, elements: results }
        return {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return errorResponse(err.message)
      }
    }
  )

  server.registerTool(
    "wait_for_element",
    {
      description: "Poll the UI hierarchy until an element matching the selector appears, then return it. Use after a tap, launch, or navigation instead of fixed sleeps. At least one search criterion must be provided.",
      inputSchema: {
        text: z.string().optional().describe("Text content to search for (partial match, case-insensitive)"),
        resourceId: z.string().optional().describe("Resource ID to match exactly (e.g., 'com.app:id/button')"),
        className: z.string().optional().describe("Class name to match exactly (e.g., 'android.widget.Button')"),
        contentDesc: z.string().optional().describe("Content description to search for (partial match, case-insensitive)"),
        timeoutSeconds: z.number().positive().optional().default(10).describe("Maximum time to wait, in seconds"),
        intervalMs: z.number().int().positive().optional().default(500).describe("Delay between hierarchy dumps, in milliseconds"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        found: z.boolean().describe("Whether a matching element appeared before the timeout"),
        elapsedMs: z.number().int().describe("Time spent waiting, in milliseconds"),
        count: z.number().int().describe("Number of matching elements at the end of the wait"),
        element: uiElementSchema.nullable().describe("First matching element, or null when nothing matched"),
        error: z.string().optional().describe("Last hierarchy dump error, if every attempt failed"),
      },
      annotations: {
        title: "Wait for UI Element",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ text, resourceId, className, contentDesc, timeoutSeconds, intervalMs, serial }) => {
      try {
        const selector = { text, resourceId, className, contentDesc }
        if (!hasSelector(selector)) {
          return errorResponse("At least one search criterion must be provided")
        }

        const s = await resolveSerial(serial)
        const startedAt = Date.now()
        const deadline = startedAt + timeoutSeconds * 1000
        let lastError: string | undefined

        while (true) {
          try {
            const matches = matchElements(parseUiNodes(await dumpUiXml(s)), selector)
            if (matches.length > 0) {
              const structured = {
                found: true,
                elapsedMs: Date.now() - startedAt,
                count: matches.length,
                element: matches[0],
              }
              return {
                content: [{ type: "text", text: JSON.stringify(structured) }],
                structuredContent: structured,
              }
            }
          } catch (error) {
            lastError = (error as Error).message
          }

          if (Date.now() >= deadline) {
            const structured = {
              found: false,
              elapsedMs: Date.now() - startedAt,
              count: 0,
              element: null,
              ...(lastError ? { error: lastError } : {}),
            }
            return {
              content: [{ type: "text", text: JSON.stringify(structured) }],
              structuredContent: structured,
            }
          }

          const { promise, resolve } = Promise.withResolvers<void>()
          setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now())))
          await promise
        }
      } catch (error) {
        const err = error as Error
        return errorResponse(err.message)
      }
    }
  )

  server.registerTool(
    "tap_element",
    {
      description: "Find an element by selector and tap its center, optionally waiting for it to appear first. Prefers clickable matches so the tap lands on the interactive ancestor rather than its label. At least one search criterion must be provided.",
      inputSchema: {
        text: z.string().optional().describe("Text content to search for (partial match, case-insensitive)"),
        resourceId: z.string().optional().describe("Resource ID to match exactly (e.g., 'com.app:id/button')"),
        className: z.string().optional().describe("Class name to match exactly (e.g., 'android.widget.Button')"),
        contentDesc: z.string().optional().describe("Content description to search for (partial match, case-insensitive)"),
        index: z.number().int().nonnegative().optional().default(0).describe("Which match to tap when several qualify, in hierarchy order"),
        preferClickable: z.boolean().optional().default(true).describe("Restrict candidates to clickable elements when any exist"),
        waitSeconds: z.number().nonnegative().optional().default(0).describe("Wait up to this long for a match before tapping"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        tapped: z.boolean().describe("Whether a tap was sent"),
        elapsedMs: z.number().int().describe("Time spent waiting for the element, in milliseconds"),
        candidates: z.number().int().describe("Number of matching elements considered"),
        element: uiElementSchema.nullable().describe("The element that was tapped, or null when none matched"),
        error: z.string().optional().describe("Last hierarchy dump error, if every attempt failed"),
      },
      annotations: {
        title: "Tap UI Element",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      text,
      resourceId,
      className,
      contentDesc,
      index,
      preferClickable,
      waitSeconds,
      serial,
    }) => {
      try {
        const selector = { text, resourceId, className, contentDesc }
        if (!hasSelector(selector)) {
          return errorResponse("At least one search criterion must be provided")
        }

        const s = await resolveSerial(serial)
        const startedAt = Date.now()
        const deadline = startedAt + waitSeconds * 1000
        let matches: UiElement[] = []
        let lastError: string | undefined

        while (true) {
          try {
            matches = matchElements(parseUiNodes(await dumpUiXml(s)), selector)
          } catch (error) {
            lastError = (error as Error).message
            matches = []
          }

          if (matches.length > 0 || Date.now() >= deadline) {
            break
          }
          const { promise, resolve } = Promise.withResolvers<void>()
          setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
          await promise
        }

        if (matches.length === 0) {
          const structured = {
            tapped: false,
            elapsedMs: Date.now() - startedAt,
            candidates: 0,
            element: null,
            ...(lastError ? { error: lastError } : {}),
          }
          return {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
          }
        }

        const clickable = matches.filter((element) => element.clickable)
        const candidates = preferClickable && clickable.length > 0 ? clickable : matches
        if (index >= candidates.length) {
          return errorResponse(`index ${index} is out of range: ${candidates.length} candidate(s) matched`)
        }

        const target = candidates[index]
        await execAdbShell(s, `input tap ${target.tapX} ${target.tapY}`)

        const structured = {
          tapped: true,
          elapsedMs: Date.now() - startedAt,
          candidates: candidates.length,
          element: target,
        }
        return {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
        }
      } catch (error) {
        const err = error as Error
        return errorResponse(err.message)
      }
    }
  )
}
