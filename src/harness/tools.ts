import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { Sandbox } from "../sandbox/sandbox.js";

const EXECUTE_PARAMETERS = Type.Object({
  name: Type.String({
    description: "Hand name: bash | read_file | write_file | list_files",
  }),
  input: Type.Any({
    description: "Hand-specific input object",
  }),
});

type ExecuteParameters = Static<typeof EXECUTE_PARAMETERS>;

export const EXECUTE_TOOL_NAME = "execute";

const DESCRIPTION = `Execute one hand in the sandbox. The brain does not know what the hand is; it only knows this interface.

Available hands:
- bash: { "command": "shell command", "timeoutMs"?: number }
- read_file: { "path": "relative/path" }
- write_file: { "path": "relative/path", "content": "text" }
- list_files: { "path"?: "relative/path", "depth"?: number }

Paths are relative to the sandbox root. Absolute paths are rejected.`;

/**
 * The only tool the harness gives the brain.
 *
 * Every sandbox, MCP server, phone or emulator is reached through this same
 * `execute(name, input) -> string` shape.
 */
export function createExecuteTool(sandbox: Sandbox): AgentTool<typeof EXECUTE_PARAMETERS> {
  return {
    name: EXECUTE_TOOL_NAME,
    label: "execute(name, input)",
    description: DESCRIPTION,
    parameters: EXECUTE_PARAMETERS,
    execute: async (_toolCallId, params: ExecuteParameters) => {
      const hand = params.name;
      const input = (params.input ?? {}) as Record<string, unknown>;
      try {
        const output = await sandbox.execute(hand, input);
        return {
          content: [{ type: "text", text: output.length > 0 ? output : "(no output)" }],
          details: { hand, ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Sandbox error: ${message}` }],
          details: { hand, ok: false },
          isError: true,
        };
      }
    },
  };
}
