// End-to-end smoke test: connects to a running chatgpt-local-bridge server via the MCP client SDK.
// Exercises the tool surface, path-whitelist denial, per-session server, AND the M2 confirmation
// flow (overwrite/delete → pending token → confirm_action) + Level-0 permission denial.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.env.MCP_URL || "http://127.0.0.1:3911/mcp";
const SERVER_URL_LEVEL0 = process.env.MCP_URL_LEVEL0 || "";
const DATA = process.env.MCP_DATA || "/tmp/clb-e2e-data";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}
function extractToken(text) {
  const m = /token="([^"]+)"/.exec(text || "");
  return m ? m[1] : null;
}

async function connect(url) {
  const t = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name: "e2e-smoke", version: "1.0" }, { capabilities: {} });
  await c.connect(t);
  return c;
}

// ---- Level-1 server ----
const client = await connect(SERVER_URL);
console.log("Connected to", SERVER_URL);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log("Tools:", names.join(", "));
check("12 tools registered (incl. confirm_action + run_command + get_project_info)", names.length === 12, `(got ${names.length})`);
check("confirm_action present", names.includes("confirm_action"));
check("run_command present", names.includes("run_command"));

check("read_file returns content", /\bhello from e2e\b/.test((await client.callTool({ name: "read_file", arguments: { path: `${DATA}/hello.txt` } })).content?.[0]?.text ?? ""));
const denied = await client.callTool({ name: "read_file", arguments: { path: "/etc/hosts" } });
check("read_file denies /etc/hosts", denied.isError === true);

check("write_file creates (new file, no confirm)", /Created/.test((await client.callTool({ name: "write_file", arguments: { path: `${DATA}/written.txt`, content: "REPLACE_ME" } })).content?.[0]?.text ?? ""));
check("edit_file ok", /Edited 1 occurrence/.test((await client.callTool({ name: "edit_file", arguments: { path: `${DATA}/written.txt`, old_text: "REPLACE_ME", new_text: "EDITED_OK" } })).content?.[0]?.text ?? ""));
check("edit applied", /EDITED_OK/.test((await client.callTool({ name: "read_file", arguments: { path: `${DATA}/written.txt` } })).content?.[0]?.text ?? ""));
check("list_directory works", /written\.txt/.test((await client.callTool({ name: "list_directory", arguments: { path: DATA } })).content?.[0]?.text ?? ""));

// second concurrent session (per-session McpServer)
const client2 = await connect(SERVER_URL);
check("second session works (per-session server)", /\bhello from e2e\b/.test((await client2.callTool({ name: "read_file", arguments: { path: `${DATA}/hello.txt` } })).content?.[0]?.text ?? ""));
await client2.close();

// ---- M2 Layer-3 confirmation: overwrite existing file ----
const overwrite = await client.callTool({ name: "write_file", arguments: { path: `${DATA}/hello.txt`, content: "OVERWRITTEN" } });
const oToken = extractToken(overwrite.content?.[0]?.text ?? "");
check("overwrite returns pending token (Layer 3)", !!oToken, JSON.stringify(overwrite.content));
if (oToken) {
  const conf = await client.callTool({ name: "confirm_action", arguments: { token: oToken, decision: "confirm" } });
  check("confirm_action executes overwrite", /Overwrote/.test(conf.content?.[0]?.text ?? ""), JSON.stringify(conf.content));
  check("overwrite actually applied", /OVERWRITTEN/.test((await client.callTool({ name: "read_file", arguments: { path: `${DATA}/hello.txt` } })).content?.[0]?.text ?? ""));
}

// ---- M2 Layer-3 confirmation: delete, then CANCEL ----
const delReq = await client.callTool({ name: "delete_file", arguments: { path: `${DATA}/written.txt` } });
const dToken = extractToken(delReq.content?.[0]?.text ?? "");
check("delete returns pending token (Layer 3)", !!dToken, JSON.stringify(delReq.content));
if (dToken) {
  const cancel = await client.callTool({ name: "confirm_action", arguments: { token: dToken, decision: "cancel" } });
  check("confirm_action(cancel) aborts", /cancelled/i.test(cancel.content?.[0]?.text ?? ""));
  const stillThere = await client.callTool({ name: "read_file", arguments: { path: `${DATA}/written.txt` } });
  check("file still exists after cancel", /EDITED_OK/.test(stillThere.content?.[0]?.text ?? ""));
}

// ---- M3: get_project_info ----
const proj = await client.callTool({ name: "get_project_info", arguments: { path: DATA } });
check("get_project_info lists entries", /hello\.txt/.test(proj.content?.[0]?.text ?? ""), JSON.stringify(proj.content));

// ---- M3: run_command blacklist (rejected before confirmation) ----
const blocked = await client.callTool({ name: "run_command", arguments: { command: "sudo echo hi" } });
check("run_command rejects blacklisted sudo", blocked.isError === true && /blocked command: sudo/.test(blocked.content?.[0]?.text ?? ""), JSON.stringify(blocked.content));

// ---- M3: run_command confirmation flow (Layer 3) ----
const cmdReq = await client.callTool({ name: "run_command", arguments: { command: "echo hello-cmd-42" } });
const cToken = extractToken(cmdReq.content?.[0]?.text ?? "");
check("run_command returns pending token", !!cToken, JSON.stringify(cmdReq.content));
if (cToken) {
  const cmdRes = await client.callTool({ name: "confirm_action", arguments: { token: cToken, decision: "confirm" } });
  check("run_command executes and returns stdout", /hello-cmd-42/.test(cmdRes.content?.[0]?.text ?? "") && /exit: 0/.test(cmdRes.content?.[0]?.text ?? ""), JSON.stringify(cmdRes.content));
}

await client.close();

// ---- Level-0 server: permission gate ----
if (SERVER_URL_LEVEL0) {
  const c0 = await connect(SERVER_URL_LEVEL0);
  const w0 = await c0.callTool({ name: "write_file", arguments: { path: `${DATA}/blocked.txt`, content: "x" } });
  check("Level 0 denies write_file (permission gate)", w0.isError === true && /Level 1/.test(w0.content?.[0]?.text ?? ""), JSON.stringify(w0.content));
  const r0 = await c0.callTool({ name: "read_file", arguments: { path: `${DATA}/hello.txt` } });
  check("Level 0 still allows read_file", !r0.isError);
  await c0.close();
}

console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
