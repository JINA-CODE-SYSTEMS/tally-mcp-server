import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cacheTable, executeSQL, validateSQL } from './database.mjs';
import { handlePull, handlePush, jsonToTSV, postTallyXML, resolveGSTLedgers } from './tally.mjs';

dotenv.config({ override: true, quiet: true });

// Audit logging — logs every tool invocation
function auditLog(toolName: string, args: Record<string, any>, status: 'success' | 'error' | 'denied', durationMs?: number): void {
  const entry = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    args: Object.fromEntries(
      Object.entries(args).filter(([k]) => !['password', 'secret', 'token'].includes(k.toLowerCase()))
    ),
    status,
    durationMs
  };
  console.log(`[audit] ${JSON.stringify(entry)}`);
}

export function getOpenCompanyGuiTimeoutSeconds(rawValue: string | undefined = process.env.OPEN_COMPANY_GUI_TIMEOUT_SEC): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 180;
  if (parsed < 90) return 180;
  return Math.floor(parsed);
}

export function getOpenCompanyGuiMaxSteps(rawValue: string | undefined = process.env.OPEN_COMPANY_GUI_MAX_STEPS): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return 25;
  if (parsed < 12) return 12;
  return Math.floor(parsed);
}

export function createGuiAgentCommandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isMatchingGuiAgentCommand(result: any, commandId: string): boolean {
  return !!result && typeof result.commandId === 'string' && result.commandId === commandId;
}

// Tracks the last company successfully opened via open-company within this server session.
let activeCompany: string | null = null;

// Wraps handlePull — injects activeCompany as targetCompany fallback when the caller did not specify one.
async function pull(reportName: string, inputParams: Map<string, any>) {
  if (!inputParams.has('targetCompany') && activeCompany) {
    inputParams.set('targetCompany', activeCompany);
  }
  return handlePull(reportName, inputParams);
}

// Wraps handlePush — injects activeCompany as targetCompany fallback when the caller did not specify one.
async function push(templateName: string, inputParams: Map<string, any>) {
  if (!inputParams.has('targetCompany') && activeCompany) {
    inputParams.set('targetCompany', activeCompany);
  }
  return handlePush(templateName, inputParams);
}

export async function registerMcpServer(): Promise<McpServer> {
  const mcpServer = new McpServer({
    name: 'Tally Prime MCP Server',
    title: 'Tally Prime',
    version: '1.0.0'
  });

  mcpServer.registerTool(
    'query-database',
    {
      title: 'Query Database',
      description: `executes sql query on DuckDB in-memory database for querying cached Tally Prime report data in table generated as output by other tools (in tableID property from tool output response). These tables are temporary and will be dropped after 15 minutes automatically. Use this tool to run complex analytical queries to aggregate, filter, sort results. Returns output in tab separated format`,
      inputSchema: {
        sql: z.string().describe('SQL query to execute on DuckDB in-memory database')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      // Validate SQL before execution — only SELECT allowed
      const sqlError = validateSQL(args.sql);
      if (sqlError) {
        auditLog('query-database', args, 'denied');
        return {
          isError: true,
          content: [{ type: 'text', text: `SQL rejected: ${sqlError}` }]
        };
      }
      try {
        const resp = await executeSQL(args.sql);
        auditLog('query-database', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: resp }]
        };
      } catch (err) {
        auditLog('query-database', args, 'error', Date.now() - start);
        throw err;
      }
    }
  );

  mcpServer.registerTool(
    'list-companies',
    {
      title: 'List Companies',
      description: `lists all company data folders found in Tally Prime data directories. Scans tally.ini for configured data path, plus common default paths. For each folder with actual data, attempts to load the company via Tally XML API to retrieve its name. Does NOT require any company to be already open. Use open-company tool to load a company before querying it.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const logs: string[] = [];

        // --- Step 1: Discover all candidate Tally data paths ---
        const candidatePaths = new Set<string>();
        const configuredPath = process.env.TALLY_DATA_PATH || '';
        if (configuredPath) candidatePaths.add(configuredPath);

        // Read tally.ini to find configured data path
        const tallyExeDir = path.dirname(process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe');
        const tallyIniCandidates = [
          path.join(tallyExeDir, 'tally.ini'),
          path.join(tallyExeDir, 'Tally.ini'),
          'C:\\Program Files\\TallyPrimeEditLog\\tally.ini',
          'C:\\Program Files\\TallyPrime\\tally.ini',
          'C:\\Program Files (x86)\\TallyPrime\\tally.ini',
          'C:\\Tally\\tally.ini',
          'C:\\TallyPrime\\tally.ini',
        ];
        for (const iniPath of tallyIniCandidates) {
          try {
            if (fs.existsSync(iniPath)) {
              const iniContent = fs.readFileSync(iniPath, 'utf-8');
              logs.push(`[tally.ini] Found: ${iniPath}`);
              logs.push(`  Content: ${iniContent.substring(0, 500)}`);
              // Parse "Data Path = ..." or "DataPath = ..." lines
              const dataPathMatch = iniContent.match(/^[\\s]*Data\\s*Path\\s*[=:]\\s*(.+)$/mi)
                || iniContent.match(/^[\\s]*DataPath\\s*[=:]\\s*(.+)$/mi);
              if (dataPathMatch) {
                const dp = dataPathMatch[1].trim().replace(/[\\r\\n]/g, '');
                candidatePaths.add(dp);
                logs.push(`  Parsed Data Path: ${dp}`);
              }
              // Also parse any path-like values
              for (const line of iniContent.split(/\\r?\\n/)) {
                const m = line.match(/(?:path|directory|data)\\s*[=:]\\s*(.+)/i);
                if (m) {
                  const p = m[1].trim();
                  if (p && p.includes('\\\\')) candidatePaths.add(p);
                }
              }
            }
          } catch {}
        }

        // Add common default data paths
        const commonPaths = [
          'C:\\Users\\Public\\TallyPrimeEditLog\\data',
          'C:\\Users\\Public\\Tally.ERP9\\Data',
          'C:\\Users\\Public\\TallyPrime\\Data',
          'C:\\TallyPrime\\Data',
          'C:\\Tally\\Data',
          'C:\\Users\\Public\\TallyPrimeEditLog\\Data',
          'D:\\TallyData',
          'D:\\Tally\\Data',
        ];
        for (const p of commonPaths) candidatePaths.add(p);

        logs.push(`[Paths] Scanning ${candidatePaths.size} candidate paths`);

        // --- Step 2: Scan all paths for company folders ---
        interface CompanyFolder {
          folder: string;
          dataPath: string;
          fullPath: string;
          fileCount: number;
          hasData: boolean;
          name: string;
        }
        const allFolders: CompanyFolder[] = [];
        const seenFolderPaths = new Set<string>();

        for (const dataPath of candidatePaths) {
          if (!fs.existsSync(dataPath)) continue;
          logs.push(`[Scan] ${dataPath}`);
          try {
            const entries = fs.readdirSync(dataPath, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
              const folderPath = path.join(dataPath, entry.name);
              if (seenFolderPaths.has(folderPath)) continue;
              seenFolderPaths.add(folderPath);

              const files = fs.readdirSync(folderPath);
              const hasData = files.some(f => {
                try {
                  const st = fs.statSync(path.join(folderPath, f));
                  return st.size > 0;
                } catch { return false; }
              });
              const fileCount = files.length;
              logs.push(`  ${entry.name}: ${fileCount} files, hasData=${hasData}`);

              allFolders.push({
                folder: entry.name,
                dataPath,
                fullPath: folderPath,
                fileCount,
                hasData,
                name: ''
              });
            }
          } catch (err) {
            logs.push(`  Error scanning ${dataPath}: ${err}`);
          }
        }

        // --- Step 3: For folders with data, try loading via Tally to get company name ---
        const foldersWithData = allFolders.filter(f => f.hasData);
        const foldersWithoutData = allFolders.filter(f => !f.hasData);

        for (const folder of foldersWithData) {
          try {
            // Try $$CmpLoadOnPath to load company and get its name
            const escapedPath = folder.fullPath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\');
            const loadXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPLoadOnPathReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPLoadOnPathReport"><FORMS>MCPLoadOnPathForm</FORMS></REPORT><FORM NAME="MCPLoadOnPathForm"><PARTS>MCPLoadOnPathPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPLoadOnPathPart"><LINES>MCPLoadOnPathLine</LINES></PART><LINE NAME="MCPLoadOnPathLine"><FIELDS>MCPLoadResult,MCPCurrentCompany</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPLoadResult"><SET>$$CmpLoadOnPath:"${escapedPath}"</SET><XMLTAG>LOADRESULT</XMLTAG></FIELD><FIELD NAME="MCPCurrentCompany"><SET>##SVCurrentCompany</SET><XMLTAG>CURRENTCOMPANY</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
            const resp = await postTallyXML(loadXml);
            logs.push(`  [${folder.folder}] $$CmpLoadOnPath response: ${resp.substring(0, 300)}`);

            // Extract company name from response
            const nameMatch = resp.match(/<CURRENTCOMPANY>([^<]+)<\/CURRENTCOMPANY>/i);
            if (nameMatch && nameMatch[1].trim()) {
              folder.name = nameMatch[1].trim();
              logs.push(`  [${folder.folder}] Company name: "${folder.name}"`);
            }
          } catch (err) {
            logs.push(`  [${folder.folder}] Error: ${err}`);
          }
        }

        // If no folders have data, try loading ALL folders anyway (maybe Tally keeps data internally)
        if (foldersWithData.length === 0 && foldersWithoutData.length > 0) {
          logs.push('[Fallback] No folders have data files. Trying all folders via Tally...');
          for (const folder of foldersWithoutData) {
            try {
              const escapedPath = folder.fullPath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\');
              const loadXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPLoadOnPathReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPLoadOnPathReport"><FORMS>MCPLoadOnPathForm</FORMS></REPORT><FORM NAME="MCPLoadOnPathForm"><PARTS>MCPLoadOnPathPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPLoadOnPathPart"><LINES>MCPLoadOnPathLine</LINES></PART><LINE NAME="MCPLoadOnPathLine"><FIELDS>MCPLoadResult,MCPCurrentCompany</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPLoadResult"><SET>$$CmpLoadOnPath:"${escapedPath}"</SET><XMLTAG>LOADRESULT</XMLTAG></FIELD><FIELD NAME="MCPCurrentCompany"><SET>##SVCurrentCompany</SET><XMLTAG>CURRENTCOMPANY</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
              const resp = await postTallyXML(loadXml);
              logs.push(`  [${folder.folder}] $$CmpLoadOnPath response: ${resp.substring(0, 300)}`);
              const nameMatch = resp.match(/<CURRENTCOMPANY>([^<]+)<\/CURRENTCOMPANY>/i);
              if (nameMatch && nameMatch[1].trim()) {
                folder.name = nameMatch[1].trim();
                folder.hasData = true; // Tally loaded it, so it has data
                logs.push(`  [${folder.folder}] Company name: "${folder.name}"`);
              }
            } catch (err) {
              logs.push(`  [${folder.folder}] Error: ${err}`);
            }
          }
        }

        // --- Step 4: Build output ---
        const allResults = [...foldersWithData, ...foldersWithoutData.filter(f => f.name)];
        if (allResults.length === 0 && allFolders.length === 0) {
          auditLog('list-companies', args, 'success', Date.now() - start);
          return { content: [{ type: 'text', text: 'No company folders found in any scanned data directory.\n\n' + logs.join('\n') }] };
        }

        const tsv = 'folder\tname\tpath\tfiles\n' +
          allFolders.map(f => `${f.folder}\t${f.name}\t${f.fullPath}\t${f.fileCount}`).join('\n');

        auditLog('list-companies', args, 'success', Date.now() - start);
        return { content: [{ type: 'text', text: tsv + '\n\n--- Discovery Log ---\n' + logs.join('\n') }] };
      } catch (err) {
        auditLog('list-companies', args, 'error', Date.now() - start);
        throw err;
      }
    }
  );

  mcpServer.registerTool(
    'open-company',
    {
      title: 'Open Company',
      description: `loads a company into Tally Prime and sets it as the active company for all subsequent queries. Accepts company name OR folder number (e.g. "010000"). When given a folder number, loads via $$CmpLoadOnPath directly (no name resolution needed). Tries strategies: (0) path-based $$CmpLoadOnPath for folder numbers, (1) $$CmpLoadCompany / $$CmpConnect by name, (2) open company list check, (3) GUI automation. Use list-companies to find folder numbers.`,
      inputSchema: {
        companyName: z.string().describe('company name as shown in Tally OR a folder number (e.g. "010000") from list-companies output.'),
        strategy: z.enum(['auto', 'path-load', 'tdl-load', 'tdl-connect', 'gui-agent']).optional().describe('which strategy to use. "auto" tries all in order (default). "path-load" uses $$CmpLoadOnPath with folder path. "tdl-load" uses $$CmpLoadCompany. "tdl-connect" uses $$CmpConnect. "gui-agent" uses GUI automation.')
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      const strategy = args.strategy || 'auto';
      let companyName = args.companyName;
      const logs: string[] = [];

      // --- Helper: get all company names known to Tally (works even from Select Company screen) ---
      const getAllCompanyNames = async (): Promise<string[]> => {
        const names: string[] = [];
        try {
          // Method 1: Use Tally's built-in "List of Companies" request (works without any company loaded)
          const builtinXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>`;
          const builtinResp = await postTallyXML(builtinXml);
          logs.push(`  Built-in "List of Companies" response (${builtinResp.length} chars)`);
          // Parse COMPANYNAME tags from built-in response
          const companyMatches = builtinResp.match(/<COMPANYNAME[^>]*>([^<]+)<\/COMPANYNAME>/gi);
          if (companyMatches && companyMatches.length > 0) {
            for (const m of companyMatches) {
              const name = m.replace(/<\/?COMPANYNAME[^>]*>/gi, '').trim();
              if (name && !names.includes(name)) names.push(name);
            }
          }
          // Also try <NAME> tags (some Tally versions use different format)
          if (names.length === 0) {
            const nameMatches = builtinResp.match(/<NAME[^>]*>([^<]+)<\/NAME>/gi);
            if (nameMatches && nameMatches.length > 0) {
              for (const m of nameMatches) {
                const name = m.replace(/<\/?NAME[^>]*>/gi, '').trim();
                if (name && name.length > 1 && !names.includes(name)) names.push(name);
              }
            }
          }
          if (names.length > 0) return names;
        } catch (err) {
          logs.push(`  Built-in request failed: ${err}`);
        }
        try {
          // Method 2: Custom TDL with Company collection (works when at least one company is loaded)
          const listXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPListCompaniesReport</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <REPORT NAME="MCPListCompaniesReport"><FORMS>MCPListCompaniesForm</FORMS></REPORT>
      <FORM NAME="MCPListCompaniesForm"><PARTS>MCPListCompaniesPart</PARTS><XMLTAG>DATA</XMLTAG></FORM>
      <PART NAME="MCPListCompaniesPart"><LINES>MCPListCompaniesLine</LINES><REPEAT>MCPListCompaniesLine : MCPAllCompaniesCol</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
      <LINE NAME="MCPListCompaniesLine"><FIELDS>MCPCompanyNameFld, MCPCompanyNumFld</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
      <FIELD NAME="MCPCompanyNameFld"><SET>$Name</SET><XMLTAG>NAME</XMLTAG></FIELD>
      <FIELD NAME="MCPCompanyNumFld"><SET>$$FolderName:$CompanyMailName</SET><XMLTAG>NUMBER</XMLTAG></FIELD>
      <COLLECTION NAME="MCPAllCompaniesCol"><TYPE>Company</TYPE></COLLECTION>
    </TDLMESSAGE></TDL></DESC></BODY>
</ENVELOPE>`;
          const listResp = await postTallyXML(listXml);
          const nameMatches = listResp.match(/<NAME>([^<]+)<\/NAME>/g);
          if (nameMatches && nameMatches.length > 0) {
            for (const m of nameMatches) {
              const name = m.replace(/<\/?NAME>/g, '').trim();
              if (name && !names.includes(name)) names.push(name);
            }
          }
        } catch {}
        return names;
      };

      // --- Strategy 0: Path-based loading for folder numbers ---
      const tryPathLoad = async (): Promise<boolean> => {
        // Find the folder path for this input
        const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const commonPaths = [
          tallyDataPath,
          'C:\\Users\\Public\\TallyPrimeEditLog\\data',
          'C:\\Users\\Public\\Tally.ERP9\\Data',
          'C:\\Users\\Public\\TallyPrime\\Data',
          'C:\\TallyPrime\\Data',
          'C:\\Tally\\Data',
          'D:\\TallyData',
          'D:\\Tally\\Data',
        ];
        // If input is a folder number, search all data paths for it
        const isFolder = /^\d+$/.test(companyName);
        const fullPaths: string[] = [];
        if (isFolder) {
          for (const dp of commonPaths) {
            const fp = path.join(dp, companyName);
            if (fs.existsSync(fp)) fullPaths.push(fp);
          }
          // Also check if it's a direct path
        } else if (fs.existsSync(companyName)) {
          fullPaths.push(companyName);
        }

        if (fullPaths.length === 0) {
          logs.push(`[Strategy 0: Path Load] No folder found for "${companyName}"`);
          return false;
        }

        for (const folderPath of fullPaths) {
          logs.push(`[Strategy 0: Path Load] Trying $$CmpLoadOnPath: ${folderPath}`);
          try {
            const escapedPath = folderPath.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\');
            const loadXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPPathLoadReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPPathLoadReport"><FORMS>MCPPathLoadForm</FORMS></REPORT><FORM NAME="MCPPathLoadForm"><PARTS>MCPPathLoadPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPPathLoadPart"><LINES>MCPPathLoadLine</LINES></PART><LINE NAME="MCPPathLoadLine"><FIELDS>MCPPathLoadResult,MCPPathCurrentCompany</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPPathLoadResult"><SET>$$CmpLoadOnPath:"${escapedPath}"</SET><XMLTAG>LOADRESULT</XMLTAG></FIELD><FIELD NAME="MCPPathCurrentCompany"><SET>##SVCurrentCompany</SET><XMLTAG>CURRENTCOMPANY</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
            const resp = await postTallyXML(loadXml);
            logs.push(`  Response: ${resp.substring(0, 300)}`);

            // Check if company was loaded
            const nameMatch = resp.match(/<CURRENTCOMPANY>([^<]+)<\/CURRENTCOMPANY>/i);
            if (nameMatch && nameMatch[1].trim()) {
              companyName = nameMatch[1].trim();
              logs.push(`  Company loaded: "${companyName}"`);
              return true;
            }

            // Wait and retry — loading might take a moment
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Query current company
            try {
              const checkXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPCheckCurrent</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPCheckCurrent"><FORMS>MCPCheckForm</FORMS></REPORT><FORM NAME="MCPCheckForm"><PARTS>MCPCheckPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPCheckPart"><LINES>MCPCheckLine</LINES></PART><LINE NAME="MCPCheckLine"><FIELDS>MCPCheckField</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPCheckField"><SET>##SVCurrentCompany</SET><XMLTAG>NAME</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
              const checkResp = await postTallyXML(checkXml);
              const checkMatch = checkResp.match(/<NAME>([^<]+)<\/NAME>/i);
              if (checkMatch && checkMatch[1].trim()) {
                companyName = checkMatch[1].trim();
                logs.push(`  After wait, current company: "${companyName}"`);
                return true;
              }
            } catch {}

            logs.push(`  $$CmpLoadOnPath did not return a company name.`);
          } catch (err) {
            logs.push(`  Error: ${err}`);
          }
        }
        return false;
      };

      // --- Resolve folder number to company name if needed (for name-based strategies) ---
      // If input looks like a folder number and path load isn't being used, try to get the real name
      if (/^\d+$/.test(companyName)) {
        logs.push(`[Pre-check] Input "${companyName}" looks like a folder number, trying to resolve company name...`);
        try {
          const names = await getAllCompanyNames();
          if (names.length > 0) {
            logs.push(`  Found companies: ${names.join(', ')}`);
            if (names.length === 1) {
              companyName = names[0];
              logs.push(`  Resolved to: "${companyName}"`);
            } else {
              companyName = names[0];
              logs.push(`  Multiple companies found, using first: "${companyName}"`);
            }
          } else {
            logs.push(`  No company names resolved from Tally.`);
          }
        } catch (err) {
          logs.push(`  Could not resolve company name from Tally: ${err}`);
        }
      }

      // --- Helper: verify company is accessible via SVCURRENTCOMPANY ---
      const verifyCompanyLoaded = async (targetName: string): Promise<boolean> => {
        try {
          const escaped = targetName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPVerifyCompanyReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escaped}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPVerifyCompanyReport"><FORMS>MCPVerifyForm</FORMS></REPORT><FORM NAME="MCPVerifyForm"><PARTS>MCPVerifyPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPVerifyPart"><LINES>MCPVerifyLine</LINES></PART><LINE NAME="MCPVerifyLine"><FIELDS>MCPVerifyField</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPVerifyField"><SET>##SVCurrentCompany</SET><XMLTAG>NAME</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
          const resp = await postTallyXML(xml);
          // Tally echoes back the current company name — match confirms the company is accessible
          return resp.toLowerCase().includes(`<name>${targetName.toLowerCase()}`);
        } catch {
          return false;
        }
      };

      // --- Strategy 1: SVCURRENTCOMPANY probe + $$CmpLoadCompany attempt ---
      const tryTdlLoad = async (): Promise<boolean> => {
        logs.push('[Strategy 1: TDL Load] Checking if company is directly accessible...');
        // First check if already accessible
        const accessible = await verifyCompanyLoaded(companyName);
        if (accessible) {
          logs.push('  Company is accessible in Tally (server mode or already open).');
          return true;
        }
        logs.push('  Company not accessible via SVCURRENTCOMPANY. Attempting $$CmpLoadCompany via inline TDL...');

        // Try to load company using $$CmpLoadCompany (works if Tally has the company in its data directory)
        try {
          const escaped = companyName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const loadXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPTdlLoadReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><MCPTARGETCOMPANY>${escaped}</MCPTARGETCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPTdlLoadReport"><FORMS>MCPTdlLoadForm</FORMS></REPORT><FORM NAME="MCPTdlLoadForm"><PARTS>MCPTdlLoadPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPTdlLoadPart"><LINES>MCPTdlLoadLine</LINES></PART><LINE NAME="MCPTdlLoadLine"><FIELDS>MCPTdlLoadResult</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPTdlLoadResult"><SET>$$CmpLoadCompany:##MCPTargetCompany</SET><XMLTAG>RESULT</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
          const loadResp = await postTallyXML(loadXml);
          logs.push(`  $$CmpLoadCompany response (${loadResp.length} chars): ${loadResp.substring(0, 200)}`);

          // Wait for company to load
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Verify
          const loaded = await verifyCompanyLoaded(companyName);
          if (loaded) {
            logs.push('  $$CmpLoadCompany succeeded! Company is now accessible.');
            return true;
          }
          logs.push('  $$CmpLoadCompany did not make company accessible.');
        } catch (err) {
          logs.push(`  $$CmpLoadCompany failed: ${err}`);
        }

        // Try $$CmpConnect as alternative
        try {
          const escaped = companyName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const connectXml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MCPTdlConnectReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><MCPTARGETCOMPANY>${escaped}</MCPTARGETCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MCPTdlConnectReport"><FORMS>MCPTdlConnectForm</FORMS></REPORT><FORM NAME="MCPTdlConnectForm"><PARTS>MCPTdlConnectPart</PARTS><XMLTAG>DATA</XMLTAG></FORM><PART NAME="MCPTdlConnectPart"><LINES>MCPTdlConnectLine</LINES></PART><LINE NAME="MCPTdlConnectLine"><FIELDS>MCPTdlConnectResult</FIELDS><XMLTAG>ROW</XMLTAG></LINE><FIELD NAME="MCPTdlConnectResult"><SET>$$CmpConnect:##MCPTargetCompany</SET><XMLTAG>RESULT</XMLTAG></FIELD></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
          const connectResp = await postTallyXML(connectXml);
          logs.push(`  $$CmpConnect response (${connectResp.length} chars): ${connectResp.substring(0, 200)}`);

          await new Promise(resolve => setTimeout(resolve, 3000));

          const loaded = await verifyCompanyLoaded(companyName);
          if (loaded) {
            logs.push('  $$CmpConnect succeeded! Company is now accessible.');
            return true;
          }
          logs.push('  $$CmpConnect did not make company accessible.');
        } catch (err) {
          logs.push(`  $$CmpConnect failed: ${err}`);
        }

        return false;
      };

      // --- Strategy 2: open company list check — detects if company is already loaded in Tally UI ---
      const tryTdlConnect = async (): Promise<boolean> => {
        logs.push('[Strategy 2: open company list] Checking if company is in Tally open company list...');
        try {
          // Use handlePull directly — must NOT inject activeCompany here; we want ALL open companies
          const inputParams = new Map([['collection', 'company']]);
          const resp = await handlePull('list-master', inputParams);
          if (resp.data && resp.data.length > 0) {
            const openNames = resp.data.map((c: any) => String(c.F01 || c.name || '').toLowerCase().trim());
            logs.push(`  Open companies in Tally: ${openNames.join(', ')}`);
            const found = openNames.includes(companyName.toLowerCase().trim());
            logs.push(`  ${found ? 'Company found in open list.' : 'Company not in open list.'}`);
            return found;
          }
          logs.push('  No companies returned from Tally.');
          return false;
        } catch (err) {
          logs.push(`  Error: ${err}`);
          return false;
        }
      };

      // --- Strategy 3: GUI Agent - sends commands to the companion agent running in the interactive session ---
      const tryGuiAgent = async (): Promise<boolean> => {
        logs.push('[Strategy 3: GUI Agent] Attempting...');
        try {
          const guiTimeoutSeconds = getOpenCompanyGuiTimeoutSeconds();
          const guiMaxSteps = getOpenCompanyGuiMaxSteps();
          const tallyDataPath = process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
          const commandFile = path.join(tallyDataPath, '_mcp_gui_command.json');
          const resultFile = path.join(tallyDataPath, '_mcp_gui_result.json');

          // Check if Tally is running at all
          let tallyRunning = true;
          try {
            await postTallyXML('<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>');
          } catch {
            tallyRunning = false;
          }

          const action = tallyRunning ? 'select-company' : 'load-on-startup';
          logs.push(`  Tally running: ${tallyRunning}, action: ${action}`);

          // If Tally isn't running, try to start it first
          if (!tallyRunning) {
            const tallyExe = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
            if (fs.existsSync(tallyExe)) {
              logs.push('  Starting Tally...');
              try { execSync(`start "" "${tallyExe}"`, { timeout: 5000, shell: 'cmd' }); } catch {}
              await new Promise(resolve => setTimeout(resolve, 10000));
            }
          }

          // --- First, ping the agent to check if it's alive ---
          const pingCommandId = createGuiAgentCommandId('ping');
          try { fs.unlinkSync(resultFile); } catch {}
          fs.writeFileSync(commandFile, JSON.stringify({ action: 'ping', commandId: pingCommandId, timestamp: new Date().toISOString() }), 'utf-8');
          let agentAlive = false;
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (fs.existsSync(resultFile)) {
              try {
                const pingResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
                if (isMatchingGuiAgentCommand(pingResult, pingCommandId)) {
                  agentAlive = true;
                  try { fs.unlinkSync(resultFile); } catch {}
                  break;
                }
                logs.push(`  Ignoring stale ping response for commandId ${pingResult?.commandId || 'unknown'}.`);
                try { fs.unlinkSync(resultFile); } catch {}
              } catch {
                try { fs.unlinkSync(resultFile); } catch {}
              }
            }
          }

          if (!agentAlive) {
            logs.push('  GUI agent not running. Please start scripts/tally-gui-agent-v2.ps1 in the interactive desktop session.');
            return false;
          }
          logs.push('  GUI agent is alive.');

          // --- Send the actual command ---
          const commandId = createGuiAgentCommandId('open-company');
          try { fs.unlinkSync(resultFile); } catch {}
          const command = JSON.stringify({
            action: action,
            companyName: companyName,
            commandId: commandId,
            maxSteps: guiMaxSteps,
            timestamp: new Date().toISOString()
          });
          fs.writeFileSync(commandFile, command, 'utf-8');
          logs.push(`  Command sent (commandId=${commandId}, maxSteps=${guiMaxSteps}), waiting for GUI agent (up to ${guiTimeoutSeconds} seconds for LLM-guided actions)...`);

          // Poll for result — timeout is configurable because LLM-guided actions can take longer.
          let agentResponded = false;
          for (let i = 0; i < guiTimeoutSeconds; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (fs.existsSync(resultFile)) {
              try {
                const resultText = fs.readFileSync(resultFile, 'utf-8');
                const result = JSON.parse(resultText);
                if (!isMatchingGuiAgentCommand(result, commandId)) {
                  logs.push(`  Ignoring stale response for commandId ${result?.commandId || 'unknown'}.`);
                  try { fs.unlinkSync(resultFile); } catch {}
                  continue;
                }
                logs.push(`  Agent response: ${result.status} - ${result.message}`);
                agentResponded = true;
                try { fs.unlinkSync(resultFile); } catch {}
                if (result.status !== 'success') return false;
                break;
              } catch {}
            }
          }

          if (!agentResponded) {
            logs.push(`  Agent did not respond within ${guiTimeoutSeconds} seconds.`);
            return false;
          }

          // Wait for Tally to process the company load
          await new Promise(resolve => setTimeout(resolve, 5000));

          const loaded = await verifyCompanyLoaded(companyName);
          logs.push(`  Verification: ${loaded ? 'SUCCESS' : 'company not detected in active list'}`);
          return loaded;
        } catch (err) {
          logs.push(`  Error: ${err}`);
          return false;
        }
      };

      // --- Execute strategies ---
      try {
        let success = false;

        // --- Strategy 0: Path-based loading (best for folder numbers) ---
        if (strategy === 'auto' || strategy === 'path-load') {
          success = await tryPathLoad();
          if (success || strategy === 'path-load') {
            if (success) activeCompany = companyName;
            auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
            return {
              isError: !success,
              content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active.` : '') }]
            };
          }
        }

        if (strategy === 'auto' || strategy === 'tdl-load') {
          success = await tryTdlLoad();
          if (success || strategy === 'tdl-load') {
            if (success) activeCompany = companyName;
            auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
            return {
              isError: !success,
              content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` : '') }]
            };
          }
        }

        if (strategy === 'auto' || strategy === 'tdl-connect') {
          success = await tryTdlConnect();
          if (success || strategy === 'tdl-connect') {
            if (success) activeCompany = companyName;
            auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
            return {
              isError: !success,
              content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` : '') }]
            };
          }
        }

        if (strategy === 'auto' || strategy === 'gui-agent') {
          success = await tryGuiAgent();
          if (success) activeCompany = companyName;
          auditLog('open-company', args, success ? 'success' : 'error', Date.now() - start);
          return {
            isError: !success,
            content: [{ type: 'text', text: logs.join('\n') + (success ? `\n\nCompany "${companyName}" is now active. Subsequent tools will automatically target this company.` : '\n\nAll strategies failed. Ensure tally-gui-agent-v2.ps1 is running in the interactive desktop session, then retry.') }]
          };
        }

        auditLog('open-company', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: logs.join('\n') + '\n\nAll strategies exhausted.' }] };
      } catch (err) {
        auditLog('open-company', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: `Failed to open company: ${err}\n\n${logs.join('\n')}` }] };
      }
    }
  );

  mcpServer.registerTool(
    'open-company-debug',
    {
      title: 'Open Company Debug',
      description: `checks open-company readiness (paths, agent files, env flags, process status) and optionally includes the latest GUI agent result payload for troubleshooting.`,
      inputSchema: {
        includeRecentResult: z.boolean().optional().describe('include parsed contents of latest _mcp_gui_result.json if available'),
        watchDir: z.string().optional().describe('optional explicit watch/data directory override')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      try {
        const tallyDataPath = args.watchDir || process.env.TALLY_DATA_PATH || 'C:\\Users\\Public\\TallyPrimeEditLog\\data';
        const tallyExePath = process.env.TALLY_EXE_PATH || 'C:\\Program Files\\TallyPrimeEditLog\\tally.exe';
        const commandFile = path.join(tallyDataPath, '_mcp_gui_command.json');
        const resultFile = path.join(tallyDataPath, '_mcp_gui_result.json');
        const guiScriptPath = path.join(process.cwd(), 'scripts', 'tally-gui-agent-v2.ps1');
        const guiDllPath = path.join(process.cwd(), 'scripts', 'TallyUI.dll');

        const report: Record<string, any> = {
          timestamp: new Date().toISOString(),
          tallyDataPath,
          tallyDataPathExists: fs.existsSync(tallyDataPath),
          tallyExePath,
          tallyExeExists: fs.existsSync(tallyExePath),
          guiScriptPath,
          guiScriptExists: fs.existsSync(guiScriptPath),
          guiDllPath,
          guiDllExists: fs.existsSync(guiDllPath),
          commandFile,
          commandFileExists: fs.existsSync(commandFile),
          resultFile,
          resultFileExists: fs.existsSync(resultFile),
          openAiKeySet: !!process.env.OPENAI_API_KEY,
          anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
          configuredTimeoutSeconds: getOpenCompanyGuiTimeoutSeconds(),
          configuredMaxSteps: getOpenCompanyGuiMaxSteps(),
          activeCompany: activeCompany || null
        };

        try {
          // Fast probe that does not require external commands.
          const pingEnvelope = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>';
          const pingResp = await postTallyXML(pingEnvelope);
          report.tallyXmlProbe = {
            reachable: true,
            sample: pingResp.substring(0, 160)
          };
        } catch (err) {
          report.tallyXmlProbe = {
            reachable: false,
            error: String(err)
          };
        }

        if (args.includeRecentResult && fs.existsSync(resultFile)) {
          try {
            report.recentResult = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          } catch (err) {
            report.recentResult = { parseError: String(err) };
          }
        }

        auditLog('open-company-debug', args, 'success', Date.now() - start);
        return {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
        };
      } catch (err) {
        auditLog('open-company-debug', args, 'error', Date.now() - start);
        return {
          isError: true,
          content: [{ type: 'text', text: `open-company-debug failed: ${err}` }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'list-master',
    {
      title: 'List Masters',
      description: `fetches list of masters from Tally Prime collection e.g. group, ledger, vouchertype, unit, godown, stockgroup, stockitem, costcategory, costcentre, attendancetype, company, currency, gstin, gstclassification returns output in tab separated format`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        collection: z.string(z.enum(['group', 'ledger', 'vouchertype', 'unit', 'godown', 'stockgroup', 'stockitem', 'costcategory', 'costcentre', 'attendancetype', 'company', 'currency', 'gstin', 'gstclassification']))
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['collection', args.collection]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('list-master', inputParams);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: jsonToTSV(resp.data) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'chart-of-accounts',
    {
      title: 'Chart of Accounts',
      description: `fetches chart of accounts or group structure / GL hierarchywith fields group_name, group_parent, bs_pl, dr_cr, affects_gross_profit. the column bs_pl will have values BS = Balance Sheet / PL = Profit Loss. Column dr_cr as value D = Debit / C = Credit. columns group and parent are tree structure represented in flat format. The column affects_gross_profit has values Y = Yes / N = No, it is used to determine if ledger under this group will affect gross profit or not. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map();
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('chart-of-accounts', inputParams);
      const tableId = await cacheTable('chart-of-accounts', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'trial-balance',
    {
      title: 'Trial Balance',
      description: `fetches trial balance with fields ledger_name, group_name, opening_balance, net_debit, net_credit, closing_balance. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('trial-balance', inputParams);
      const tableId = await cacheTable('trial-balance', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'profit-loss',
    {
      title: 'Profit and Loss',
      description: `fetches profit and loss statement with fields like ledger_name, group_name, amount, parent_group. amount negative is debit or expense and positive is credit or income. group_name is the immediate parent group of the ledger. parent_group is the grandparent / top-level primary group under which the group_name falls (e.g. Indirect Expenses, Direct Expenses, Sales Accounts, Purchase Accounts etc.). Use parent_group to aggregate sub-groups under their primary category. Always use financial year end date (31-Mar) as toDate for full year reports, not today's date. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('profit-loss', inputParams);
      const tableId = await cacheTable('profit-loss', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'balance-sheet',
    {
      title: 'Balance Sheet',
      description: `fetches balance sheet with fields like ledger_name, group_name, closing_balance. closing balance negative is debit or asset and positive is credit or liability. kindly fetch data from chart-of-accounts tool to pull group hierarchy before calling this tool. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('balance-sheet', inputParams);
      const tableId = await cacheTable('balance-sheet', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-summary',
    {
      title: 'Stock Summary',
      description: `fetches stock item summary with fields name, parent, opening_quantity, opening_value, inward_quantity, inward_value, outward_quantity, outward_value, closing_quantity, closing_value, returns output cached in DuckDB in-memory table (specified in tableID property). synonyms (name=stock item / parent=stock group) Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-summary', inputParams);
      const tableId = await cacheTable('stock-summary', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-balance',
    {
      title: 'Ledger Balance',
      description: `fetches ledger closing balance as on date, negative is debit and positive is credit`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        ledgerName: z.string().describe('exact ledger name, validate it using list-master tool with collection as ledger'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['ledgerName', args.ledgerName], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('ledger-balance', inputParams);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify(resp.data) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-item-balance',
    {
      title: 'Stock Item Balance',
      description: `fetches stock item remaining quantity balance as on date`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        itemName: z.string().describe('exact stock item name, validate it using list-master tool with collection as stockitem'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['itemName', args.itemName], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-item-balance', inputParams);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify(resp.data) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'bills-outstanding',
    {
      title: 'Bills Outstanding',
      description: `fetches pending overdue outstanding bills receivable or payable as on date with fields bill_date,reference_number,outstanding_amount,party_name,overdue_days. outstanding_amount = Debit is negative and Credit is positive. party_name = ledger_name. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        nature: z.enum(['receivable', 'payable']),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['nature', args.nature], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('bills-outstanding', inputParams);
      const tableId = await cacheTable('bills-outstanding', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'ledger-account',
    {
      title: 'Ledger Account',
      description: `fetches GL ledger account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, amount, narration, party_gstin, cgst_amount, sgst_amount, igst_amount. amount = debit is negative and credit is positive. party_name = ledger_name. GST tax amounts (cgst_amount, sgst_amount, igst_amount) are included per voucher entry where applicable. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        ledgerName: z.string().describe('exact ledger name, validate it using list-master tool with collection as ledger'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['ledgerName', args.ledgerName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      const resp = await pull('ledger-account', inputParams);
      const tableId = await cacheTable('ledger-account', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {

        //swap opening balance row to the top since it came at the end from Tally XML response
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          const lastItem = resp.data.pop();
          resp.data.unshift(lastItem);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'stock-item-account',
    {
      title: 'Stock Item Account',
      description: `fetches GL stock item account statement with voucher level details containing fields date, voucher_type, voucher_number, party_name, quantity, amount, narration, tracking_number, voucher_category. party_name = ledger_name. quantity = inward as positive and outward as negative. amount = debit is negative and credit is positive, narration = notes / remarks. for calculating closing balance of quantity, consider rows with tracking_number as empty as it is, but for rows with tracking_number having text value, then duplicate rows need to be removed by preparing intermediate output with aggregation of tracking_number and voucher_category with sum of quantity and then comparing quantity of Receipt Note with Purchase and Delivery Note with Sales to identify and remove the rows with Receipt Note and Delivery Note if they are found to be tracked fully / partially . returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        itemName: z.string().describe('exact stock item name, validate it using list-master tool with collection as stockitem'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate], ['itemName', args.itemName]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }

      const resp = await pull('stock-item-account', inputParams);
      const tableId = await cacheTable('stock-item-account', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {

        //swap opening balance row to the top since it came at the end from Tally XML response
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          const lastItem = resp.data.pop();
          resp.data.unshift(lastItem);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }

    }
  );

  mcpServer.registerTool(
    'gst-voucher-details',
    {
      title: 'GST Voucher Details',
      description: `fetches GST tax breakup of vouchers (Sales, Purchase, Debit Note, Credit Note) for a date range with fields date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, cess_amount, invoice_value, reverse_charge, narration. amounts negative = debit, positive = credit. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gst-voucher-details', inputParams);
      const tableId = await cacheTable('gst-voucher-details', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'stock-item-gst',
    {
      title: 'Stock Item GST Details',
      description: `fetches GST configuration of all stock items with fields item_name, parent_group, hsn_code, gst_applicability, type_of_supply (Goods/Services), tax_classification, igst_rate, cgst_rate, sgst_rate, cess_rate. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map();
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('stock-item-gst', inputParams);
      const tableId = await cacheTable('stock-item-gst', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gst-hsn-summary',
    {
      title: 'GST HSN Summary',
      description: `fetches HSN-wise summary of GST transactions for a date range with fields hsn_code, description, uqc (unit quantity code), quantity, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, total_tax, invoice_value. useful for GST return filing (GSTR-1 HSN summary). returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gst-hsn-summary', inputParams);
      const tableId = await cacheTable('gst-hsn-summary', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gstr1-summary',
    {
      title: 'GSTR-1 Outward Supplies Summary',
      description: `fetches GSTR-1 style outward supplies summary for a date range. Covers Sales and Debit Note / Credit Note vouchers with GST details. Fields: date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, invoice_value, reverse_charge, supply_type (B2B/B2C). Use supply_type to segregate B2B vs B2C invoices. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gstr1-summary', inputParams);
      const tableId = await cacheTable('gstr1-summary', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  mcpServer.registerTool(
    'gstr2-summary',
    {
      title: 'GSTR-2 Inward Supplies Summary',
      description: `fetches GSTR-2 style inward supplies summary for a date range. Covers Purchase and Debit Note / Credit Note vouchers with GST details. Fields: date, voucher_type, voucher_number, party_name, party_gstin, place_of_supply, taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, invoice_value, reverse_charge, itc_eligibility. Useful for ITC (Input Tax Credit) reconciliation and GSTR-2B matching. returns output cached in DuckDB in-memory table (specified in tableID property). Use query-database tool to run SQL queries against that table for further analysis`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company. validate it using list-master tool with collection as company if specified'),
        fromDate: z.string().describe('date in YYYY-MM-DD format'),
        toDate: z.string().describe('date in YYYY-MM-DD format')
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      let inputParams = new Map([['fromDate', args.fromDate], ['toDate', args.toDate]]);
      if (args.targetCompany) {
        inputParams.set('targetCompany', args.targetCompany);
      }
      const resp = await pull('gstr2-summary', inputParams);
      const tableId = await cacheTable('gstr2-summary', resp.data);
      if (resp.error) {
        return {
          isError: true,
          content: [{ type: 'text', text: resp.error }]
        };
      }
      else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tableID: tableId }) }]
        };
      }
    }
  );

  // ==================== PUSH TOOLS ====================

  mcpServer.registerTool(
    'create-voucher',
    {
      title: 'Create Voucher',
      description: `creates a new voucher entry in Tally Prime. Supports voucher types: Sales, Purchase, Payment, Receipt, Contra, Journal, Debit Note, Credit Note. Debit and credit ledger names must exactly match existing ledgers in Tally — validate using list-master tool with collection as ledger before calling this tool. Amount must be greater than 0. Debit and credit ledger must be different. Returns success status with created voucher ID`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        voucherType: z.enum(['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Journal', 'Debit Note', 'Credit Note']).describe('type of voucher to create'),
        date: z.string().describe('voucher date in YYYY-MM-DD format'),
        debitLedger: z.string().describe('exact debit ledger name — validate using list-master tool with collection as ledger'),
        creditLedger: z.string().describe('exact credit ledger name — validate using list-master tool with collection as ledger'),
        amount: z.number().describe('voucher amount, must be greater than 0'),
        narration: z.string().optional().describe('optional narration / remarks for the voucher'),
        voucherNumber: z.string().optional().describe('optional voucher number. leave blank for auto-numbering')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Write operations are disabled (READONLY_MODE=true)' }] };
      }
      // validate amount > 0
      if (args.amount <= 0) {
        auditLog('create-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Amount must be greater than 0' }] };
      }
      // validate debit != credit
      if (args.debitLedger.trim().toLowerCase() === args.creditLedger.trim().toLowerCase()) {
        auditLog('create-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Debit and credit ledger must be different' }] };
      }
      // validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        auditLog('create-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Date must be in YYYY-MM-DD format' }] };
      }

      let inputParams = new Map<string, any>([
        ['voucherType', args.voucherType],
        ['date', args.date],
        ['debitLedger', args.debitLedger],
        ['creditLedger', args.creditLedger],
        ['amount', args.amount]
      ]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.narration) inputParams.set('narration', args.narration);
      if (args.voucherNumber) inputParams.set('voucherNumber', args.voucherNumber);

      const resp = await push('voucher', inputParams);
      if (!resp.success) {
        auditLog('create-voucher', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: resp.error || 'Failed to create voucher' }] };
      }
      auditLog('create-voucher', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created, lastVchId: resp.lastVchId }) }]
      };
    }
  );

  mcpServer.registerTool(
    'create-ledger',
    {
      title: 'Create Ledger',
      description: `creates a new GL ledger master in Tally Prime. Parent group must exactly match an existing group in Tally — validate using list-master tool with collection as group before calling. Returns success status`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        name: z.string().describe('ledger name to create'),
        parentGroup: z.string().describe('exact parent group name — validate using list-master tool with collection as group'),
        openingBalance: z.number().optional().describe('optional opening balance. negative = debit, positive = credit'),
        mailingName: z.string().optional().describe('optional mailing name / display name'),
        gstRegistrationType: z.enum(['Regular', 'Composition', 'Unregistered', 'Consumer', 'Unknown']).optional().describe('optional GST registration type for party ledgers'),
        gstin: z.string().optional().describe('optional GSTIN number for party ledgers')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-ledger', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Write operations are disabled (READONLY_MODE=true)' }] };
      }
      if (!args.name || args.name.trim() === '') {
        auditLog('create-ledger', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Ledger name cannot be empty' }] };
      }

      let inputParams = new Map<string, any>([
        ['name', args.name],
        ['parentGroup', args.parentGroup]
      ]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.openingBalance !== undefined) inputParams.set('openingBalance', args.openingBalance);
      if (args.mailingName) inputParams.set('mailingName', args.mailingName);
      if (args.gstRegistrationType) inputParams.set('gstRegistrationType', args.gstRegistrationType);
      if (args.gstin) inputParams.set('gstin', args.gstin);

      const resp = await push('ledger', inputParams);
      if (!resp.success) {
        auditLog('create-ledger', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: resp.error || 'Failed to create ledger' }] };
      }
      auditLog('create-ledger', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created }) }]
      };
    }
  );

  mcpServer.registerTool(
    'create-stock-item',
    {
      title: 'Create Stock Item',
      description: `creates a new stock item master in Tally Prime. Parent group and unit must exactly match existing stock group and unit in Tally — validate using list-master tool with collection as stockgroup and unit respectively. Returns success status`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        name: z.string().describe('stock item name to create'),
        parentGroup: z.string().optional().describe('optional parent stock group — validate using list-master tool with collection as stockgroup'),
        unit: z.string().optional().describe('optional base unit — validate using list-master tool with collection as unit'),
        openingQuantity: z.number().optional().describe('optional opening quantity'),
        openingRate: z.number().optional().describe('optional opening rate per unit'),
        hsnCode: z.string().optional().describe('optional HSN/SAC code for GST'),
        gstRate: z.number().optional().describe('optional GST rate percentage')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-stock-item', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Write operations are disabled (READONLY_MODE=true)' }] };
      }
      if (!args.name || args.name.trim() === '') {
        auditLog('create-stock-item', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Stock item name cannot be empty' }] };
      }

      let inputParams = new Map<string, any>([
        ['name', args.name]
      ]);
      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.parentGroup) inputParams.set('parentGroup', args.parentGroup);
      if (args.unit) inputParams.set('unit', args.unit);
      if (args.openingQuantity !== undefined) inputParams.set('openingQuantity', args.openingQuantity);
      if (args.openingRate !== undefined) inputParams.set('openingRate', args.openingRate);
      if (args.openingQuantity !== undefined && args.openingRate !== undefined) {
        inputParams.set('openingValue', args.openingQuantity * args.openingRate);
      }
      if (args.hsnCode) inputParams.set('hsnCode', args.hsnCode);
      if (args.gstRate !== undefined) inputParams.set('gstRate', args.gstRate);

      const resp = await push('stock-item', inputParams);
      if (!resp.success) {
        auditLog('create-stock-item', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: resp.error || 'Failed to create stock item' }] };
      }
      auditLog('create-stock-item', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created }) }]
      };
    }
  );

  mcpServer.registerTool(
    'create-gst-voucher',
    {
      title: 'Create GST Voucher',
      description: `creates a GST-compliant voucher (Sales, Purchase, Debit Note, Credit Note) in Tally Prime with automatic tax ledger allocation. Provide taxable value and GST rate — the tool will auto-calculate CGST+SGST (intra-state) or IGST (inter-state) based on place of supply. Tax ledger names are auto-resolved from Tally. Party ledger and sale/purchase ledger names must exactly match existing ledgers — validate using list-master tool with collection as ledger. For Debit Note / Credit Note, provide originalInvoiceNumber and optionally originalInvoiceDate to link back to the original invoice. Returns success status with created voucher ID`,
      inputSchema: {
        targetCompany: z.string().optional().describe('optional company name. leave it blank or skip this to choose for default company'),
        voucherType: z.enum(['Sales', 'Purchase', 'Debit Note', 'Credit Note']).describe('type of GST voucher to create'),
        date: z.string().describe('voucher date in YYYY-MM-DD format'),
        partyLedger: z.string().describe('exact party (customer/supplier) ledger name — validate using list-master tool with collection as ledger'),
        salePurchaseLedger: z.string().describe('exact sales or purchase ledger name — validate using list-master tool with collection as ledger'),
        taxableValue: z.number().describe('taxable amount before GST, must be greater than 0'),
        gstRate: z.number().describe('GST rate percentage (e.g. 18 for 18% GST). CGST and SGST will be half each for intra-state, or full IGST for inter-state'),
        isInterState: z.boolean().describe('true = inter-state supply (IGST), false = intra-state supply (CGST + SGST)'),
        placeOfSupply: z.string().optional().describe('optional place of supply state name for GST determination'),
        isReverseCharge: z.boolean().optional().describe('optional reverse charge flag, defaults to false'),
        narration: z.string().optional().describe('optional narration / remarks for the voucher'),
        voucherNumber: z.string().optional().describe('optional voucher number. leave blank for auto-numbering'),
        originalInvoiceNumber: z.string().optional().describe('original invoice number — required for Debit Note / Credit Note to link back to the original invoice'),
        originalInvoiceDate: z.string().optional().describe('original invoice date in YYYY-MM-DD format — optional for Debit Note / Credit Note'),
        cgstLedger: z.string().optional().describe('optional exact CGST ledger name. if not provided, auto-resolved from Tally'),
        sgstLedger: z.string().optional().describe('optional exact SGST ledger name. if not provided, auto-resolved from Tally'),
        igstLedger: z.string().optional().describe('optional exact IGST ledger name. if not provided, auto-resolved from Tally')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const start = Date.now();
      if (process.env.READONLY_MODE === 'true') {
        auditLog('create-gst-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Write operations are disabled (READONLY_MODE=true)' }] };
      }
      // validate taxable value
      if (args.taxableValue <= 0) {
        auditLog('create-gst-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Taxable value must be greater than 0' }] };
      }
      // validate GST rate
      if (args.gstRate < 0 || args.gstRate > 100) {
        auditLog('create-gst-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'GST rate must be between 0 and 100' }] };
      }
      // validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
        auditLog('create-gst-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Date must be in YYYY-MM-DD format' }] };
      }
      // validate party != sale/purchase ledger
      if (args.partyLedger.trim().toLowerCase() === args.salePurchaseLedger.trim().toLowerCase()) {
        auditLog('create-gst-voucher', args, 'denied');
        return { isError: true, content: [{ type: 'text', text: 'Party ledger and sale/purchase ledger must be different' }] };
      }

      // auto-resolve tax ledgers if not provided
      let cgstLedger = args.cgstLedger;
      let sgstLedger = args.sgstLedger;
      let igstLedger = args.igstLedger;

      if ((!args.isInterState && (!cgstLedger || !sgstLedger)) || (args.isInterState && !igstLedger)) {
        const resolveParams = new Map<string, any>();
        const _gtc = args.targetCompany || activeCompany;
        if (_gtc) resolveParams.set('targetCompany', _gtc);
        const gstLedgers = await resolveGSTLedgers(resolveParams);

        if (!args.isInterState) {
          if (!cgstLedger) cgstLedger = gstLedgers.cgst;
          if (!sgstLedger) sgstLedger = gstLedgers.sgst;
          if (!cgstLedger || !sgstLedger) {
            return { isError: true, content: [{ type: 'text', text: 'Could not auto-resolve CGST/SGST ledger names from Tally. Please provide cgstLedger and sgstLedger explicitly' }] };
          }
        } else {
          if (!igstLedger) igstLedger = gstLedgers.igst;
          if (!igstLedger) {
            return { isError: true, content: [{ type: 'text', text: 'Could not auto-resolve IGST ledger name from Tally. Please provide igstLedger explicitly' }] };
          }
        }
      }

      // calculate tax amounts
      const taxableValue = Math.round(args.taxableValue * 100) / 100;
      let cgstAmount = 0, sgstAmount = 0, igstAmount = 0;

      if (args.isInterState) {
        igstAmount = Math.round(taxableValue * args.gstRate) / 100;
      } else {
        const halfRate = args.gstRate / 2;
        cgstAmount = Math.round(taxableValue * halfRate) / 100;
        sgstAmount = Math.round(taxableValue * halfRate) / 100;
      }

      const totalInvoiceValue = Math.round((taxableValue + cgstAmount + sgstAmount + igstAmount) * 100) / 100;

      const isSalesType = args.voucherType === 'Sales' || args.voucherType === 'Credit Note';
      const isPurchaseType = args.voucherType === 'Purchase' || args.voucherType === 'Debit Note';

      let inputParams = new Map<string, any>([
        ['voucherType', args.voucherType],
        ['date', args.date],
        ['partyLedger', args.partyLedger],
        ['salePurchaseLedger', args.salePurchaseLedger],
        ['taxableValue', taxableValue],
        ['totalInvoiceValue', totalInvoiceValue],
        ['isSalesType', isSalesType],
        ['isPurchaseType', isPurchaseType]
      ]);

      if (args.targetCompany) inputParams.set('targetCompany', args.targetCompany);
      if (args.narration) inputParams.set('narration', args.narration);
      if (args.voucherNumber) inputParams.set('voucherNumber', args.voucherNumber);
      if (args.placeOfSupply) inputParams.set('placeOfSupply', args.placeOfSupply);
      if (args.isReverseCharge) inputParams.set('isReverseCharge', true);
      if (args.originalInvoiceNumber) inputParams.set('originalInvoiceNumber', args.originalInvoiceNumber);
      if (args.originalInvoiceDate) inputParams.set('originalInvoiceDate', args.originalInvoiceDate);

      if (!args.isInterState) {
        inputParams.set('cgstLedger', cgstLedger!);
        inputParams.set('cgstAmount', cgstAmount);
        inputParams.set('sgstLedger', sgstLedger!);
        inputParams.set('sgstAmount', sgstAmount);
      } else {
        inputParams.set('igstLedger', igstLedger!);
        inputParams.set('igstAmount', igstAmount);
      }

      const resp = await push('gst-voucher', inputParams);
      if (!resp.success) {
        auditLog('create-gst-voucher', args, 'error', Date.now() - start);
        return { isError: true, content: [{ type: 'text', text: resp.error || 'Failed to create GST voucher' }] };
      }
      auditLog('create-gst-voucher', args, 'success', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, created: resp.created, lastVchId: resp.lastVchId, taxBreakup: { taxableValue, cgstAmount, sgstAmount, igstAmount, totalInvoiceValue } }) }]
      };
    }
  );

  return mcpServer;
}