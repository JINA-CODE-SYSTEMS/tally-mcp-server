import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dotenv from 'dotenv';
import { z } from 'zod';
import { cacheTable, executeSQL, validateSQL } from './database.mjs';
import { handlePull, handlePush, jsonToTSV, resolveGSTLedgers } from './tally.mjs';

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
      const resp = await handlePull('list-master', inputParams);
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
      const resp = await handlePull('chart-of-accounts', inputParams);
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
      const resp = await handlePull('trial-balance', inputParams);
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
      const resp = await handlePull('profit-loss', inputParams);
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
      const resp = await handlePull('balance-sheet', inputParams);
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
      const resp = await handlePull('stock-summary', inputParams);
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
      const resp = await handlePull('ledger-balance', inputParams);
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
      const resp = await handlePull('stock-item-balance', inputParams);
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
      const resp = await handlePull('bills-outstanding', inputParams);
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

      const resp = await handlePull('ledger-account', inputParams);
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

      const resp = await handlePull('stock-item-account', inputParams);
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
      const resp = await handlePull('gst-voucher-details', inputParams);
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
      const resp = await handlePull('stock-item-gst', inputParams);
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
      const resp = await handlePull('gst-hsn-summary', inputParams);
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
      const resp = await handlePull('gstr1-summary', inputParams);
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
      const resp = await handlePull('gstr2-summary', inputParams);
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

      const resp = await handlePush('voucher', inputParams);
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

      const resp = await handlePush('ledger', inputParams);
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

      const resp = await handlePush('stock-item', inputParams);
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
        if (args.targetCompany) resolveParams.set('targetCompany', args.targetCompany);
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

      const resp = await handlePush('gst-voucher', inputParams);
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