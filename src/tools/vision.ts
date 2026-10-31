import { spawn } from "child_process"
import * as fs from "fs"
import * as nodePath from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { execAdbRaw, resolveSerial } from "../utils/adb.js"
import {
  getSession,
  getLatestFrame,
  hasActiveSession,
  isVideoRecording,
  startSession,
  startVideoRecording,
  stopVideoRecording,
} from "../utils/scrcpy.js"
import { findFfmpeg, findFfprobe } from "../utils/ffmpeg.js"

interface FinishedRecording {
  localPath: string
  format: "mp4" | "h264"
  bytes: number
  durationSeconds: number
  message: string
}

const finishedRecordings = new Map<string, FinishedRecording>()
const autoStopTimers = new Map<string, NodeJS.Timeout>()

function recordingError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, message }, null, 2) }],
    isError: true as const,
  }
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = spawn(findFfprobe(), args)
    let out = ""
    let err = ""
    probe.stdout?.on("data", (data: Buffer) => { out += data.toString() })
    probe.stderr?.on("data", (data: Buffer) => { err += data.toString() })
    probe.once("error", reject)
    probe.once("exit", (code: number | null) => {
      if (code === 0) {
        resolve(out.trim())
      } else {
        reject(new Error(err.trim() || `ffprobe exited with code ${code}`))
      }
    })
  })
}

async function countFrames(rawPath: string): Promise<number> {
  try {
    const out = await runFfprobe([
      "-v", "error", "-count_frames", "-select_streams", "v",
      "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1",
      rawPath,
    ])
    const frames = Number.parseInt(out, 10)
    return Number.isFinite(frames) ? frames : 0
  } catch {
    return 0
  }
}

async function probeDuration(path: string): Promise<number | null> {
  try {
    const out = await runFfprobe([
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", path,
    ])
    const seconds = Number.parseFloat(out)
    return Number.isFinite(seconds) ? seconds : null
  } catch {
    return null
  }
}

function remuxToMp4(rawPath: string, targetPath: string, frameRate?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-y"]
    if (frameRate !== undefined) {
      // Raw H.264 carries no presentation timestamps. Without an explicit
      // input frame rate ffmpeg derives one from the SPS VUI, which on this
      // device compresses a 6s capture into 2s of playback. Spreading the
      // frames evenly across the measured wall-clock duration keeps playback
      // length equal to the recording length.
      args.push("-r", String(frameRate))
    }
    args.push(
      "-f", "h264", "-i", rawPath,
      "-c", "copy", "-movflags", "+faststart",
      targetPath
    )

    const ffmpeg = spawn(findFfmpeg(), args)

    let stderrText = ""
    ffmpeg.stderr?.on("data", (data: Buffer) => {
      stderrText += data.toString()
      if (stderrText.length > 2000) {
        stderrText = stderrText.slice(-2000)
      }
    })
    ffmpeg.once("error", reject)
    ffmpeg.once("exit", (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderrText.trim() || `ffmpeg exited with code ${code}`))
      }
    })
  })
}

async function finalizeRecording(
  rawPath: string,
  targetPath: string,
  durationMs: number,
  message: string
): Promise<FinishedRecording> {
  const wallSeconds = durationMs / 1000
  const frames = await countFrames(rawPath)
  const frameRate = frames > 0 && wallSeconds > 0
    ? Math.min(240, Math.max(1, Math.round((frames / wallSeconds) * 1000) / 1000))
    : undefined
  try {
    await remuxToMp4(rawPath, targetPath, frameRate)
    const stat = await fs.promises.stat(targetPath)
    await fs.promises.unlink(rawPath).catch(() => undefined)
    const fileSeconds = await probeDuration(targetPath)
    const durationSeconds = Math.round((fileSeconds ?? wallSeconds) * 10) / 10
    return { localPath: targetPath, format: "mp4", bytes: stat.size, durationSeconds, message }
  } catch (err) {
    const stat = await fs.promises.stat(rawPath)
    return {
      localPath: rawPath,
      format: "h264",
      bytes: stat.size,
      durationSeconds: Math.round(wallSeconds * 10) / 10,
      message: `${message} Remux failed (${(err as Error).message}); raw H.264 kept — playable with ffplay.`,
    }
  }
}

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
      description: "Start recording the device screen to a file on the host. Recording taps the scrcpy session's raw H.264 stream (one encoder, no `screenrecord` on the device), so it works on ROMs where the screen_record SELinux domain cannot write files. Starts a scrcpy session if needed. Stops automatically after `duration` seconds when given.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
        localPath: z
          .string()
          .optional()
          .describe("Host path for the final MP4 (default /data/recording-<serial>.mp4 when /data exists, else ./recording-<serial>.mp4)"),
        duration: z
          .number()
          .positive()
          .optional()
          .describe("Auto-stop after this many seconds (no device-side 180s limit)"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether recording was started"),
        message: z.string().describe("Human-readable status message"),
        localPath: z.string().optional().describe("Host path the MP4 will be written to"),
        rawPath: z.string().optional().describe("Host path of the raw H.264 file being written while recording"),
      },
      annotations: {
        title: "Start Screen Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ serial, localPath, duration }) => {
      try {
        const s = await resolveSerial(serial)

        if (isVideoRecording(s)) {
          return recordingError(`A screen recording is already in progress for ${s}.`)
        }

        if (!hasActiveSession(s)) {
          await startSession(s)
        }

        const session = getSession(s)
        if (!session || !session.videoAvailable || !session.videoSocket) {
          return recordingError(
            `No scrcpy video stream for ${s}; screen recording needs an active scrcpy session.`
          )
        }

        const target = localPath ?? nodePath.join(
          fs.existsSync("/data") ? "/data" : ".",
          `recording-${s}.mp4`
        )
        const rawPath = `${target}.h264`

        startVideoRecording(s, rawPath)

        if (duration !== undefined) {
          const timer = setTimeout(() => {
            autoStopTimers.delete(s)
            void (async () => {
              const stopped = await stopVideoRecording(s)
              if (!stopped) return
              const result = await finalizeRecording(
                stopped.rawPath,
                target,
                stopped.durationMs,
                `Recording auto-stopped after ${duration}s.`
              )
              finishedRecordings.set(s, result)
              console.error(`[recording] ${s} auto-stopped: ${result.localPath}`)
            })().catch((err: Error) => {
              console.error(`[recording] ${s} auto-stop failed:`, err.message)
            })
          }, duration * 1000)
          autoStopTimers.set(s, timer)
        }

        const structured = {
          success: true,
          message: duration !== undefined
            ? `Recording started on ${s}; auto-stops after ${duration}s.`
            : `Recording started on ${s}; call screen_record_stop to finish.`,
          localPath: target,
          rawPath,
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        }
      } catch (error) {
        return recordingError(`Failed to start recording: ${(error as Error).message}`)
      }
    }
  );

  server.registerTool(
    "screen_record_stop",
    {
      description: "Stop screen recording, remux the raw H.264 stream to MP4 with ffmpeg (raw file kept if remux fails), and return the host path.",
      inputSchema: {
        serial: z.string().optional().describe("Device serial number"),
      },
      outputSchema: {
        success: z.boolean().describe("Whether a recording was finalized"),
        message: z.string().describe("Human-readable status message"),
        localPath: z.string().optional().describe("Host path of the finalized recording"),
        bytes: z.number().int().optional().describe("Size of the finalized file in bytes"),
        durationSeconds: z.number().optional().describe("Recording duration in seconds"),
        format: z.string().optional().describe("Container of the finalized file (mp4 or h264)"),
      },
      annotations: {
        title: "Stop Screen Recording",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ serial }) => {
      try {
        const s = await resolveSerial(serial)

        const timer = autoStopTimers.get(s)
        if (timer) {
          clearTimeout(timer)
          autoStopTimers.delete(s)
        }

        if (isVideoRecording(s)) {
          const stopped = await stopVideoRecording(s)
          if (!stopped) {
            return recordingError(`No recording in progress for ${s}.`)
          }
          const target = stopped.rawPath.endsWith(".h264")
            ? stopped.rawPath.slice(0, -5)
            : `${stopped.rawPath}.mp4`
          const result = await finalizeRecording(
            stopped.rawPath,
            target,
            stopped.durationMs,
            `Recording stopped after ${Math.round(stopped.durationMs / 1000)}s.`
          )
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) }],
            structuredContent: { success: true, ...result },
          }
        }

        const finished = finishedRecordings.get(s)
        if (finished) {
          finishedRecordings.delete(s)
          const structured = { success: true, ...finished }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
            structuredContent: structured,
          }
        }

        return recordingError(`No recording in progress for ${s}.`)
      } catch (error) {
        return recordingError(`Failed to stop recording: ${(error as Error).message}`)
      }
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
