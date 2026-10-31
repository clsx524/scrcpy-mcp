import { spawn, ChildProcess } from "child_process"
import * as fs from "fs"
import * as nodePath from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdb, execAdbRaw, resolveSerial } from "../utils/adb.js"
import { ADB_PATH } from "../utils/constants.js"
import { getSession, getLatestFrame } from "../utils/scrcpy.js"

interface RecordingSession {
  proc: ChildProcess;
  remotePath: string;
}

const recordingSessions: Map<string, RecordingSession> = new Map();

export function registerVisionTools(server: McpServer) {
  server.registerTool(
    "screenshot",
    {
      description: "Take a screenshot of the Android device screen. Returns the image as base64.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        mimeType: z.string().describe("MIME type of the returned image"),
        encoding: z.string().describe("Encoding of the image data in the content block"),
        source: z.string().describe("Capture path used (scrcpy frame or adb screencap)"),
      },
      annotations: {
        title: "Screenshot",
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial }) => {
      const s = await resolveSerial(serial);

      const session = getSession(s);
      if (session && session.controlSocket && !session.controlSocket.destroyed) {
        const frame = getLatestFrame(s);
        if (frame && frame.length > 0) {
          return {
            content: [
              {
                type: "image" as const,
                data: frame.toString("base64"),
                mimeType: "image/jpeg",
              },
            ],
            structuredContent: { mimeType: "image/jpeg", encoding: "base64", source: "scrcpy" },
          };
        }
      }

      const pngBuffer = await execAdbRaw(["-s", s, "exec-out", "screencap", "-p"]);

      return {
        content: [
          {
            type: "image" as const,
            data: pngBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
        structuredContent: { mimeType: "image/png", encoding: "base64", source: "adb" },
      };
    }
  );

  server.registerTool(
    "screen_record_start",
    {
      description: "Start recording the screen. Recording continues until screen_record_stop is called.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        remotePath: z
          .string()
          .optional()
          .default("/sdcard/scrcpy-mcp-recording.mp4")
          .describe("Path on device to save recording"),
        duration: z
          .number()
          .optional()
          .describe("Max recording duration in seconds (optional, device limit usually 180s)"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether recording was started"),
        message: z.string().describe("Human-readable status message"),
        remotePath: z.string().optional().describe("Path on the device where the recording is saved"),
      },
      annotations: {
        title: "Start Screen Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ serial, remotePath, duration }) => {
      const s = await resolveSerial(serial);

      if (recordingSessions.has(s)) {
        const message = `Recording already in progress for device ${s}`;
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { success: false, message },
        };
      }

      const args = ["-s", s, "shell", "screenrecord"];
      if (duration !== undefined) {
        args.push("--time-limit", String(duration));
      }
      args.push(remotePath);

      return new Promise((resolve) => {
        const proc = spawn(ADB_PATH, args)

        proc.once("error", (err) => {
          console.error(`[screenrecord ${s}] Failed to start: ${err.message}`)
          resolve({
            content: [
              {
                type: "text" as const,
                text: `Failed to start recording on device ${s}: ${err.message}`,
              },
            ],
            isError: true as const,
          })
        })

        proc.once("spawn", () => {
          recordingSessions.set(s, { proc, remotePath })

          proc.on("close", () => {
            recordingSessions.delete(s)
          })

          proc.stderr?.on("data", (data) => {
            console.error(`[screenrecord ${s}] ${data}`)
          })

          const message = `Recording started on device ${s}. Will save to ${remotePath}`
          resolve({
            content: [{ type: "text" as const, text: message }],
            structuredContent: { success: true, message, remotePath },
          })
        })
      })
    }
  );

  server.registerTool(
    "screen_record_stop",
    {
      description: "Stop screen recording and optionally pull the file to the host.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        pullToHost: z
          .boolean()
          .optional()
          .default(false)
          .describe("Pull the recording to the host machine"),
        localPath: z
          .string()
          .optional()
          .describe("Local path to save recording (only if pullToHost is true)"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether recording was stopped"),
        message: z.string().describe("Human-readable status message"),
        localPath: z.string().optional().describe("Host path the recording was pulled to, if requested"),
      },
      annotations: {
        title: "Stop Screen Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ serial, pullToHost, localPath }) => {
      const s = await resolveSerial(serial);

      const session = recordingSessions.get(s);
      if (!session) {
        const message = `No recording in progress for device ${s}`;
        return {
          content: [{ type: "text" as const, text: message }],
          structuredContent: { success: false, message },
        };
      }

      const { proc, remotePath } = session;
      recordingSessions.delete(s);

      proc.kill("SIGINT");

      await Promise.race([
        new Promise<void>((resolve) => proc.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);

      if (pullToHost) {
        const targetPath = localPath || `./recording-${s}.mp4`;
        try {
          await execAdb(["-s", s, "pull", remotePath, targetPath]);
          const message = `Recording stopped and saved to ${targetPath}`;
          return {
            content: [{ type: "text" as const, text: message }],
            structuredContent: { success: true, message, localPath: targetPath },
          };
        } catch (error) {
          const err = error as Error;
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to pull recording from ${remotePath} to ${targetPath}: ${err.message}`,
              },
            ],
            isError: true as const,
          };
        }
      }

      const message = `Recording stopped. File saved on device at ${remotePath}`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message },
      };
    }
  );

  server.registerTool(
    "screenshot_to_file",
    {
      description: "Capture the device screen and save the PNG on the host machine, returning the path and size instead of image data. Use when the MCP client cannot render image content blocks, or when the file must be inspected with host tools.",
      inputSchema: {
        localPath: z.string().describe("Absolute host path to write the PNG file to"),
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether the file was written"),
        localPath: z.string().describe("Host path of the written PNG"),
        bytes: z.number().int().describe("Size of the written file in bytes"),
        mimeType: z.string().describe("MIME type of the written file"),
      },
      annotations: {
        title: "Screenshot to File",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ localPath, serial }) => {
      try {
        if (!nodePath.isAbsolute(localPath)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "localPath must be an absolute path" }),
            }],
            isError: true as const,
          };
        }

        const s = await resolveSerial(serial);
        const pngBuffer = await execAdbRaw(["-s", s, "exec-out", "screencap", "-p"]);

        fs.mkdirSync(nodePath.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, pngBuffer);

        const structured = {
          success: true,
          localPath,
          bytes: pngBuffer.length,
          mimeType: "image/png",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (error) {
        const err = error as Error;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: err.message }),
          }],
          isError: true as const,
        };
      }
    }
  );
}
