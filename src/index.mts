import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMcpServer, setGuiTransportMode } from './mcp.mjs'

// Local (same-machine) deployment. The MCP client spawns this process, so it already runs in the
// user's interactive session where Tally is visible — Session 0 isolation, the only reason the
// file-IPC companion agent exists, does not apply here. Drive the GUI directly instead: no
// scheduled task to keep alive, no polling latency, and no decrypted password written to disk.
// GUI_TRANSPORT=ipc overrides this for anyone deliberately running the companion agent.
setGuiTransportMode('in-session');

const mcpServer = await registerMcpServer();
const transport = new StdioServerTransport(); // Start receiving messages on stdin and sending messages on stdout
await mcpServer.connect(transport); // Connect to the MCP server
