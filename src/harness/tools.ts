import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { normalizeHands, type HandName } from "../sandbox/policy.js";
import type { Sandbox } from "../sandbox/sandbox.js";

const HAND_DESCRIPTIONS: Record<HandName, string> = {
  bash: '- bash: { "command": "shell command", "timeoutMs"?: number }',
  read_file: '- read_file: { "path": "relative/path" }',
  write_file: '- write_file: { "path": "relative/path", "content": "text" }',
  list_files: '- list_files: { "path"?: "relative/path", "depth"?: number }',
};

export const EXECUTE_TOOL_NAME = "execute";

function makeParameters(hands: readonly HandName[]) {
  return Type.Object({
    name: Type.String({
      description: `Hand name: ${hands.join(" | ")}`,
    }),
    input: Type.Any({
      description: "Hand-specific input object",
    }),
  });
}

const EXECUTE_PARAMETERS = makeParameters(normalizeHands(undefined));
type ExecuteParameters = Static<typeof EXECUTE_PARAMETERS>;

function descriptionFor(hands: readonly HandName[]): string {
  return `Execute one hand in the sandbox. The brain does not know what the hand is; it only knows this interface.

Available hands:
${hands.map((hand) => HAND_DESCRIPTIONS[hand]).join("\n")}

Paths are relative to the sandbox root. Absolute paths are rejected.`;
}

/**
 * The only tool the harness gives the brain.
 *
 * Every sandbox, MCP server, phone or emulator is reached through this same
 * `execute(name, input) -> string` shape. When `allowedHands` is set, both the
 * tool description and the sandbox policy are narrowed to that set.
 */
export function createExecuteTool(
  sandbox: Sandbox,
  allowedHands?: readonly string[],
): AgentTool<typeof EXECUTE_PARAMETERS> {
  const hands = normalizeHands(allowedHands);
  const parameters = makeParameters(hands);
  return {
    name: EXECUTE_TOOL_NAME,
    label: "execute(name, input)",
    description: descriptionFor(hands),
    parameters,
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
