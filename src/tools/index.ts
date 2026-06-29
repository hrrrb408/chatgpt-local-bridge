import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, type ToolDeps } from "./registry.js";
import { readFileTool } from "./file-read.js";
import { writeFileTool, editFileTool } from "./file-write.js";
import { deleteFileTool, moveFileTool, getFileInfoTool } from "./file-manage.js";
import { listDirectoryTool, searchFilesTool } from "./directory.js";
import { searchContentTool } from "./search.js";
import { confirmActionTool } from "./confirm.js";
import { runCommandTool } from "./command.js";
import { getProjectInfoTool } from "./project.js";

const TOOLS = [
  // Level 0 — read-only
  readFileTool,
  getFileInfoTool,
  listDirectoryTool,
  searchFilesTool,
  searchContentTool,
  getProjectInfoTool,
  confirmActionTool, // confirming/cancelling is itself non-destructive (the stored op is gated)
  // Level 1 — edit
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  // Level 2 — full
  runCommandTool,
];

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  for (const spec of TOOLS) {
    registerTool(server, spec, deps);
  }
}
