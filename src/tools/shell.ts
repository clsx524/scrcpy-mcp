import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbShell, resolveSerial } from "../utils/adb.js"

export function registerShellTools(server: McpServer): void {
  server.registerTool(
    "shell_exec",
    {
      description:
        "Execute an arbitrary ADB shell command on the device and return the output. " +
        "Use this for any device operation not covered by other tools.",
      inputSchema: {
        command: z.string().describe("Shell command to execute on the device"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        output: z.string().describe("Combined stdout/stderr text from the command"),
      },
      annotations: {
        title: "ADB Shell Command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const output = await execAdbShell(s, command)
        return {
          content: [{ type: "text", text: output }],
          structuredContent: { output },
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )

  server.registerTool(
    "logcat",
    {
      description: "Read the most recent logcat lines without streaming. Optionally filter by a single tag and minimum priority. Use shell_exec for anything more complex (multiple tags, regex, buffers).",
      inputSchema: {
        lines: z.number().int().positive().max(5000).optional().default(200).describe("Number of trailing log lines to return"),
        tag: z.string().optional().describe("Single log tag to filter on (e.g., 'ActivityManager')"),
        priority: z.enum(["V", "D", "I", "W", "E", "F"]).optional().default("V").describe("Minimum priority when tag is set"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        lines: z.number().int().describe("Number of log lines requested"),
        output: z.string().describe("Logcat output"),
      },
      annotations: {
        title: "Read Logcat",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ lines, tag, priority, serial }) => {
      try {
        const s = await resolveSerial(serial)
        const parts = [`logcat -d -t ${lines}`]
        if (tag) {
          const safeTag = tag.replace(/'/g, "'\\''")
          parts.push(`-s '${safeTag}:${priority}'`)
        }
        const output = await execAdbShell(s, parts.join(" "))
        return {
          content: [{ type: "text", text: output }],
          structuredContent: { lines, output },
        }
      } catch (error) {
        const err = error as Error
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        }
      }
    }
  )
}
