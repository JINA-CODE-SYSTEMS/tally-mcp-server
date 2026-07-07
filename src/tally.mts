import dotenv from 'dotenv';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import nunjucks from 'nunjucks';
import * as m from './models.mjs';
import { utility, parseIntEnv } from './utility.mjs';

dotenv.config({ override: true, quiet: true });

const tally_host = process.env.TALLY_HOST || 'localhost'; // default to localhost
const tally_port = parseIntEnv(process.env.TALLY_PORT, 9000); // default to 9000 XML port of Tally
// Hard cap on a single Tally HTTP round trip. Tally's XML server is single-threaded
// and stops processing any request while a modal dialog (license expiry, "Bad formula",
// split-period prompts, etc.) is on screen. Without this cap, requests hang
// indefinitely and pile up. Default 30s — long enough for big balance-sheet pulls,
// short enough that the MCP client doesn't sit forever on a dead Tally.
const tally_request_timeout_ms = parseIntEnv(process.env.TALLY_REQUEST_TIMEOUT_MS, 30000);
// Pre-flight ping timeout. Short — a healthy Tally answers a Collection query in
// <100ms. If the ping doesn't come back in 3s we treat Tally as wedged and abort
// the heavy call immediately with a clear error instead of waiting the full 30s.
const tally_ping_timeout_ms = parseIntEnv(process.env.TALLY_PING_TIMEOUT_MS, 3000);
const __dirname = import.meta.dirname;
const lstPullReport: m.ModelPullReportInfo[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../pull/config.json'), 'utf-8'))['reports'];
const lstPushTemplate: m.ModelPushTemplateInfo[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../push/config.json'), 'utf-8'))['templates'];

nunjucks.configure({
    tags: {
        blockStart: '<nunjuck>',
        blockEnd: '</nunjuck>',
        variableStart: '{{',
        variableEnd: '}}',
        commentStart: '<comment>begin</comment>',
        commentEnd: '<comment>end</comment>'
    }
});

export function reportColumnMetadata(reportName: string): m.ModelPullReportOutputFieldInfo[] | undefined {
    try {
        if (Array.isArray(lstPullReport)) {
            let objReport = lstPullReport.find(r => r.name == reportName);
            if (objReport && Array.isArray(objReport.output.fields))
                return objReport.output.fields;
        }
        return undefined
    } catch (err) {
        return undefined;
    }
}

export function jsonToTSV(data: any[]): string {
    if (!data || data.length == 0)
        return '';
    let headers = Object.keys(data[0]);
    let tsv = headers.join('\t') + '\n';
    data.forEach(row => {
        let values = headers.map(header => {
            let value = row[header];
            if (typeof value === 'string') {
                value = value.replace(/\t/g, ' ').replace(/\n/g, ' ');
            }
            else if(typeof value === 'object' && value instanceof Date) {
                value = utility.Date.format(value, 'yyyy-MM-dd');
            }
            return value;
        });
        tsv += values.join('\t') + '\n';
    });
    return tsv;
}

export function handlePull(targetReport: string, inputParams: Map<string, any>): Promise<m.ModelPullResponse> {
    return new Promise<m.ModelPullResponse>(async (resolve, reject) => {
        let retval: m.ModelPullResponse = {
            data: undefined
        };
        try {
            // Pre-flight: cheap ping so a wedged Tally fails in ~3s with a clear
            // message instead of hanging the heavy report query for 30s. Skipping
            // the ping for the trivial reports that the tray dashboard / health
            // polls call thousands of times — they already are pings of a sort.
            const skipPing = targetReport === 'list-companies';
            if (!skipPing) {
                const alive = await pingTally();
                if (!alive) {
                    retval.error = `Tally is not responding (ping timed out). It may be showing a modal dialog (check the Tally window for popups like license warnings or split-period prompts), or the XML server is wedged. Dismiss any popups and retry, or restart Tally if it stays unresponsive.`;
                    return resolve(retval);
                }
            }

            let objReport = lstPullReport.find(p => p.name == targetReport);

            if (objReport) {

                let lstInputs = new Map<string, any>();

                //set target company
                let targetCompany = '##SVCurrentCompany'; //default value
                if (inputParams.has('targetCompany') && typeof inputParams.get('targetCompany') == 'string')
                    targetCompany = inputParams.get('targetCompany'); //extract from request object

                lstInputs.set('targetCompany', targetCompany); //add targetCompany as one of the params

                //populate input parameters value
                for (let i = 0; i < objReport.input.length; i++) {
                    let iName = objReport.input[i].name;
                    let iType = objReport.input[i].datatype;
                    
                    let _value = inputParams.get(iName);

                    //check if validation is required
                    if (objReport.input[i].validation_regex) {
                        let strValidationRegex = objReport.input[i].validation_regex || '';
                        let regPtrn = new RegExp(strValidationRegex, 'i');
                        if (typeof _value == 'string' && !regPtrn.test(_value)) {
                            retval.error = objReport.input[i].validation_message || `Invalid value for parameter ${iName}`;
                            return resolve(retval);
                        }
                    }

                    //parse the value based on type
                    if (typeof _value == 'number' && iType == 'number')
                        lstInputs.set(iName, _value);
                    else if (typeof _value == 'boolean' && iType == 'boolean')
                        lstInputs.set(iName, _value);
                    else if (typeof _value == 'string' && iType == 'date' && /^\d\d-\d\d-\d\d\d\d$/g.test(_value)) //Date in DD-MM-YYYY
                        lstInputs.set(iName, utility.Date.parse(_value, 'dd-MM-yyyy'));
                    else if (typeof _value == 'string' && iType == 'date' && /^\d\d\d\d-\d\d-\d\d/g.test(_value)) //ISO DateTime YYYY-MM-DDTHH:MM:SS
                        lstInputs.set(iName, utility.Date.parse(_value.substring(0, 10), 'yyyy-MM-dd'));
                    else if (typeof _value == 'string' && iType == 'string')
                        lstInputs.set(iName, _value);
                    else {
                        retval.error = `Parameter ${iName} not found or contains invalid value [${_value}]`;
                        return resolve(retval);
                    }
                }
                retval = await extractReport(objReport, lstInputs);
            }
            else
                retval.error = 'Invalid report';

        } catch (err) {
            retval.error = 'Server exception';
        } finally {
            resolve(retval);
        }
    });
}

function sendTally(xml: string, lstVariables: Map<string, any>): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
        try {

            // remove targetCompany from lstVariables if found with default value
            if (lstVariables.has('targetCompany') && lstVariables.get('targetCompany') == '##SVCurrentCompany') {
                lstVariables.delete('targetCompany');
            }

            let o = new Object();
            
            // define properties for every keys in Map in object
            lstVariables.forEach((v, k) => {
                Object.defineProperty(o, k, { enumerable: true, value: v });
            });

            let xmlRequest = nunjucks.renderString(xml, o);

            // inject company user/password credentials into STATICVARIABLES if configured
            const companyUser = process.env.TALLY_COMPANY_USER || '';
            const companyPassword = process.env.TALLY_COMPANY_PASSWORD || '';
            if (companyUser) {
                xmlRequest = xmlRequest.replace('</STATICVARIABLES>',
                    `<SVCOMPANYUSER>${utility.String.escapeHTML(companyUser)}</SVCOMPANYUSER>` +
                    `<SVCOMPANYPASSWORD>${utility.String.escapeHTML(companyPassword)}</SVCOMPANYPASSWORD>` +
                    '</STATICVARIABLES>');
            }

            let xmlResponse = await postTallyXML(xmlRequest);
            resolve(xmlResponse);
        } catch (err) {
            reject('');
        }
    });
}

export function postTallyXML(xml: string, opts?: { timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? tally_request_timeout_ms;
    return new Promise<string>((resolve, reject) => {
        try {

            let settled = false;
            const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

            let req = http.request({
                hostname: tally_host,
                port: tally_port,
                path: '',
                method: 'POST',
                headers: {
                    'Content-Length': Buffer.byteLength(xml, 'utf16le'),
                    'Content-Type': 'text/xml;charset=utf-16'
                }
            },
                (res) => {
                    let data = '';
                    res
                        .setEncoding('utf16le')
                        .on('data', (chunk) => {
                            let result = chunk.toString() || '';
                            data += result;
                        })
                        .on('end', () => {
                            settle(() => resolve(data));
                        })
                        .on('error', (httpErr) => {
                            settle(() => reject(httpErr));
                        });
                });
            req.on('error', (reqError) => {
                if (reqError && reqError.message === 'ECONNREFUSED')
                    settle(() => reject('Unable to connect to Tally'));
                else
                    settle(() => reject(reqError));
            });
            // Hard timeout: socket-level so it covers both the connect phase and a
            // hung response stream. Without this, a Tally instance showing a modal
            // dialog or otherwise wedged will leave the request open until the
            // process exits.
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(
                    `Tally did not respond within ${timeoutMs}ms. ` +
                    `It may be showing a modal dialog (check the Tally window), or the XML server is wedged. ` +
                    `Dismiss any popups in Tally and retry, or restart Tally if it's unresponsive.`
                ));
            });
            req.write(xml, 'utf16le');
            req.end();
        }
        catch (err) {
            reject(err);
        }
    });
}

// Cheap liveness check. Returns true if Tally answers a tiny Collection query
// within the configured ping timeout. Heavy tools call this first so they can
// fail fast (~3s) with a clear "Tally not responding" message instead of
// waiting the full request timeout against a wedged Tally.
export async function pingTally(timeoutMs: number = tally_ping_timeout_ms): Promise<boolean> {
    const xml = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MCPPingCollection</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="MCPPingCollection"><TYPE>Company</TYPE></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    try {
        await postTallyXML(xml, { timeoutMs });
        return true;
    } catch {
        return false;
    }
}

function substituteTDLParameters(msg: string, substitutions: Map<string, any>): string {
    let retval = msg;
    substitutions.forEach((v, k) => {
        let regPtrn = new RegExp(`\\{${k}\\}`, 'g');
        if (typeof v === 'string')
            retval = retval.replace(regPtrn, utility.String.escapeHTML(v));
        else if (typeof v === 'number')
            retval = retval.replace(regPtrn, v.toString());
        else if (v instanceof Date)
            retval = retval.replace(regPtrn, utility.Date.format(v, 'd-MMM-yyyy'));
        else if (typeof v === 'boolean')
            retval = retval.replace(regPtrn, v ? 'Yes' : 'No');
        else;
    });
    return retval;
}

function extractReport(reportConfig: m.ModelPullReportInfo, reportInputParams: Map<string, any>): Promise<m.ModelPullResponse> {
    return new Promise<m.ModelPullResponse>(async (resolve, reject) => {
        let retval: m.ModelPullResponse = {
            data: undefined
        };
        try {

            let parseString = (iStr: string): string => {
                iStr = utility.String.unescapeHTML(iStr);
                iStr = iStr.replace(/&#\d+;/g, ''); //remove unreadable characters;
                return iStr;
            }

            let parseDate = (iDate: string): Date | null => {
                if (/^\d\d\d\d-\d\d-\d\d$/g.test(iDate))
                    return utility.Date.parse(iDate, 'yyyy-MM-dd');
                else if (/^\d?\d-\w\w\w-\d\d\d\d$/g.test(iDate))
                    return utility.Date.parse(iDate, 'd-MMM-yyyy');
                else if (/^\d?\d-\w\w\w-\d\d$/g.test(iDate)) {
                    return utility.Date.parse(iDate, 'd-MMM-yy');
                }
                else
                    return null
            }

            const parseQuantity = (iStr: string): number => {
                let regPatOutput = /^(-?\d+\.\d+|-?\d+)\s.+/g.exec(iStr);
                if (regPatOutput && typeof regPatOutput[1] == 'string' && !isNaN(parseFloat(regPatOutput[1])))
                    return parseFloat(regPatOutput[1]);
                else
                    return 0;
            }

            const parseNumber = (iNum: string) => {
                if (!iNum)
                    return 0;
                else
                    return parseFloat(iNum.replace(/[\(\),]+/g, ''));
            }

            const processRows = (targetObjRows: any[], targetConfigFields: m.ModelPullReportOutputFieldInfo[]): any[] => {
                let data: any[] = [];
                let rowCount = targetObjRows.length;

                //loop through rows
                for (let r = 0; r < rowCount; r++) {
                    let o: any = new Object();

                    //loop through each field and extract value
                    for (const prop of targetConfigFields) {
                        let tagName = prop.identifier;
                        let datatype = prop.datatype;
                        let fieldName = prop.name;

                        let value: any = undefined;
                        let _value = targetObjRows[r][tagName];
                        if (_value) {
                            if (datatype == 'array' && Array.isArray(prop.fields))
                                value = processRows(targetObjRows[r][tagName], prop.fields); //recursive call to process nested array
                            else if (datatype == 'number')
                                value = parseNumber(_value);
                            else if (datatype == 'date')
                                value = parseDate(_value);
                            else if (datatype == 'boolean')
                                value = _value == '1';
                            else if (datatype == 'quantity')
                                value = parseQuantity(_value);
                            else
                                value = parseString(_value);
                        }

                        Object.defineProperty(o, fieldName, { enumerable: true, value });
                    }

                    //add row to array
                    data.push(o);
                }

                return data;
            }

            let tmplXML = fs.readFileSync(path.join(__dirname, `../pull/${reportConfig.name}.xml`), 'utf-8'); //load XML template
            tmplXML = substituteTDLParameters(tmplXML, reportInputParams); //substitute angular bracket params with values
            let respContent = await sendTally(tmplXML, reportInputParams);

            if (!respContent) {
                retval.error = 'Empty data received from Tally';
                return;
            }
            else if (respContent.startsWith('<EXCEPTION>')) {
                let regErr = respContent.match(/<EXCEPTION>(.+)<\/EXCEPTION>/g);
                let errorMessage = 'Unknown error';
                if (regErr && regErr[0])
                    errorMessage = regErr[0].substring(11, regErr[0].length - 23);

                retval.error = errorMessage;
                return;
            }

            let xmlParser = new XMLParser({
                parseTagValue: false,
                isArray(tagName, jPath, isLeafNode, isAttribute) {
                    return (tagName == 'ROW' || tagName.endsWith('.LIST'))
                },
            });
            let resultObj = xmlParser.parse(respContent);

            //process response based on the type of output
            if (reportConfig.output.datatype == 'array' && reportConfig.output.fields) {

                let data: any[] = processRows(resultObj['DATA']['ROW'], reportConfig.output.fields);
                retval.data = data;
            }
            else {
                if (resultObj['DATA'] && resultObj['DATA']['ROW'] && !resultObj['DATA']['ROW']['VALUE']) {
                    let _value: string = resultObj['DATA']['ROW'][0]['VALUE'];
                    if (reportConfig.output.datatype == 'number')
                        retval.data = parseNumber(_value);
                    else if (reportConfig.output.datatype == 'boolean')
                        retval.data = _value == '1'
                    else if (reportConfig.output.datatype == 'date')
                        retval.data = parseDate(_value);
                    else
                        retval.data = parseString(_value);
                }
            }

        } catch (err) {
        } finally {
            resolve(retval);
        }
    });
}

// Builds a faithful failure message from Tally's raw import RESPONSE instead of collapsing to
// "Tally returned 0 error(s)" (report #1). Surfaces LINEERROR + the full counts, and calls out the
// EXCEPTIONS case (created 0, errors 0, exceptions >0) — usually a non-existent parent group/ledger,
// a duplicate, or a field Tally rejected — which the old message hid entirely.
export function summarizeImportFailure(resp: any, retval: m.ModelPushResponse): string {
    const errors = parseInt(resp?.['ERRORS'] || '0');
    const exceptions = parseInt(resp?.['EXCEPTIONS'] || '0');
    const ignored = parseInt(resp?.['IGNORED'] || '0');
    const lineError = typeof resp?.['LINEERROR'] === 'string' ? resp['LINEERROR'].trim() : '';
    const counts = `created=${retval.created}, altered=${retval.altered}, errors=${errors}, exceptions=${exceptions}, ignored=${ignored}`;
    if (lineError) return `${lineError} [${counts}]`;
    if (exceptions > 0) {
        return `Tally raised ${exceptions} exception(s) with no line error — the master/voucher was NOT saved. Most commonly a referenced parent group/ledger/stock-item name is not exact, a duplicate, or a field Tally rejected. [${counts}]`;
    }
    return `Tally import failed. [${counts}]`;
}

export function handlePush(templateName: string, inputParams: Map<string, any>): Promise<m.ModelPushResponse> {
    return new Promise<m.ModelPushResponse>(async (resolve, reject) => {
        let retval: m.ModelPushResponse = {
            success: false,
            created: 0,
            altered: 0,
            lastVchId: 0
        };
        try {
            // Same pre-flight as handlePull: fail in ~3s if Tally is wedged
            // instead of waiting the full request timeout against a dead
            // socket. Writes are even more critical to fail fast on since
            // a hung push leaves the caller unsure if the voucher saved.
            const alive = await pingTally();
            if (!alive) {
                retval.error = `Tally is not responding (ping timed out). It may be showing a modal dialog (check the Tally window for popups), or the XML server is wedged. Dismiss any popups and retry, or restart Tally if it stays unresponsive.`;
                return resolve(retval);
            }

            let objTemplate = lstPushTemplate.find(t => t.name == templateName);

            if (!objTemplate) {
                retval.error = 'Invalid push template';
                return resolve(retval);
            }

            let lstInputs = new Map<string, any>();

            // set target company
            let targetCompany = '##SVCurrentCompany';
            if (inputParams.has('targetCompany') && typeof inputParams.get('targetCompany') == 'string')
                targetCompany = inputParams.get('targetCompany');
            lstInputs.set('targetCompany', targetCompany);

            // validate and populate input parameters
            for (let i = 0; i < objTemplate.input.length; i++) {
                let iName = objTemplate.input[i].name;
                let iType = objTemplate.input[i].datatype;
                let iRequired = objTemplate.input[i].required;

                let _value = inputParams.get(iName);

                // check required fields
                if (iRequired && (_value === undefined || _value === null || _value === '')) {
                    retval.error = `Required parameter ${iName} is missing`;
                    return resolve(retval);
                }

                // skip optional fields that are not provided
                if (_value === undefined || _value === null || _value === '')
                    continue;

                // check regex validation
                if (objTemplate.input[i].validation_regex) {
                    let strValidationRegex = objTemplate.input[i].validation_regex || '';
                    let regPtrn = new RegExp(strValidationRegex, 'i');
                    if (typeof _value == 'string' && !regPtrn.test(_value)) {
                        retval.error = objTemplate.input[i].validation_message || `Invalid value for parameter ${iName}`;
                        return resolve(retval);
                    }
                }

                // parse value based on type
                if (typeof _value == 'number' && iType == 'number')
                    lstInputs.set(iName, _value);
                else if (typeof _value == 'string' && iType == 'date' && /^\d\d\d\d-\d\d-\d\d/g.test(_value)) {
                    let dt = utility.Date.parse(_value.substring(0, 10), 'yyyy-MM-dd');
                    lstInputs.set(iName, dt);
                    // also set Tally-format date (YYYYMMDD) for XML template
                    lstInputs.set('tallyDate', _value.substring(0, 10).replace(/-/g, ''));
                    lstInputs.set(`${iName}TallyDate`, _value.substring(0, 10).replace(/-/g, ''));
                }
                else if (typeof _value == 'string' && iType == 'string')
                    lstInputs.set(iName, _value);
                else {
                    retval.error = `Parameter ${iName} not found or contains invalid value [${_value}]`;
                    return resolve(retval);
                }
            }

            // load and render template
            let tmplXML = fs.readFileSync(path.join(__dirname, `../push/${objTemplate.name}.xml`), 'utf-8');
            let respContent = await sendTally(tmplXML, lstInputs);

            if (!respContent) {
                retval.error = 'Empty response received from Tally';
                return resolve(retval);
            }

            // parse import response
            let xmlParser = new XMLParser({ parseTagValue: false });
            let resultObj = xmlParser.parse(respContent);

            if (resultObj['RESPONSE']) {
                let resp = resultObj['RESPONSE'];
                retval.created = parseInt(resp['CREATED'] || '0');
                retval.altered = parseInt(resp['ALTERED'] || '0');
                retval.lastVchId = parseInt(resp['LASTVCHID'] || '0');
                let errors = parseInt(resp['ERRORS'] || '0');

                if (errors > 0 || (retval.created === 0 && retval.altered === 0)) {
                    retval.success = false;
                    retval.error = summarizeImportFailure(resp, retval);
                } else {
                    retval.success = true;
                }
            } else {
                retval.error = 'Unexpected response format from Tally';
            }

        } catch (err) {
            retval.error = 'Server exception';
        } finally {
            resolve(retval);
        }
    });
}

// Posts a fully pre-rendered Import envelope (e.g. the full-fidelity voucher XML built in mcp.mts,
// which the flat template/config system can't express) and parses Tally's RESPONSE exactly like
// handlePush. Pings first (fail fast if Tally is wedged) and injects company credentials if set.
export function pushXml(xml: string): Promise<m.ModelPushResponse> {
    return new Promise<m.ModelPushResponse>(async (resolve) => {
        const retval: m.ModelPushResponse = { success: false, created: 0, altered: 0, lastVchId: 0 };
        try {
            const alive = await pingTally();
            if (!alive) {
                retval.error = 'Tally is not responding (ping timed out). Dismiss any Tally popups and retry, or restart Tally.';
                return resolve(retval);
            }
            let xmlRequest = xml;
            const companyUser = process.env.TALLY_COMPANY_USER || '';
            const companyPassword = process.env.TALLY_COMPANY_PASSWORD || '';
            if (companyUser && xmlRequest.includes('</STATICVARIABLES>')) {
                xmlRequest = xmlRequest.replace('</STATICVARIABLES>',
                    `<SVCOMPANYUSER>${utility.String.escapeHTML(companyUser)}</SVCOMPANYUSER>` +
                    `<SVCOMPANYPASSWORD>${utility.String.escapeHTML(companyPassword)}</SVCOMPANYPASSWORD>` +
                    '</STATICVARIABLES>');
            }
            const respContent = await postTallyXML(xmlRequest);
            if (!respContent) {
                retval.error = 'Empty response received from Tally';
                return resolve(retval);
            }
            const xmlParser = new XMLParser({ parseTagValue: false });
            const resultObj = xmlParser.parse(respContent);
            if (resultObj['RESPONSE']) {
                const resp = resultObj['RESPONSE'];
                retval.created = parseInt(resp['CREATED'] || '0');
                retval.altered = parseInt(resp['ALTERED'] || '0');
                retval.lastVchId = parseInt(resp['LASTVCHID'] || '0');
                const errors = parseInt(resp['ERRORS'] || '0');
                if (errors > 0 || (retval.created === 0 && retval.altered === 0)) {
                    retval.success = false;
                    retval.error = summarizeImportFailure(resp, retval);
                } else {
                    retval.success = true;
                }
            } else {
                retval.error = 'Unexpected response format from Tally';
            }
        } catch (err) {
            retval.error = 'Server exception';
        } finally {
            resolve(retval);
        }
    });
}

/**
 * Fetches chart-of-accounts from Tally and builds a lookup map
 * that resolves any group name to its primary ancestor group
 * (e.g., "EMPLOYEE BENEFIT EXPENSES" → "Indirect Expenses")
 * Works for any depth of group nesting
 */
export async function resolveGroupHierarchy(inputParams: Map<string, any>): Promise<Map<string, string>> {
    const parentMap = new Map<string, string>(); // group_name → its immediate parent
    const primaryMap = new Map<string, string>(); // group_name → primary ancestor

    const coaParams = new Map<string, any>();
    if (inputParams.has('targetCompany'))
        coaParams.set('targetCompany', inputParams.get('targetCompany'));

    const resp = await handlePull('chart-of-accounts', coaParams);
    if (!resp.data || !Array.isArray(resp.data))
        return primaryMap;

    // build parent lookup: group_name → group_parent
    for (const row of resp.data) {
        if (row.group_name && row.group_parent)
            parentMap.set(row.group_name, row.group_parent);
    }

    // walk up to primary ancestor for each group (max 20 levels to prevent infinite loops)
    for (const groupName of parentMap.keys()) {
        let current = groupName;
        for (let i = 0; i < 20; i++) {
            const parent = parentMap.get(current);
            if (!parent || parent === '' || parent === 'Primary') {
                primaryMap.set(groupName, current);
                break;
            }
            current = parent;
        }
    }

    return primaryMap;
}

/**
 * Resolves GST tax ledger names from Tally by searching the ledger list
 * for ledgers under "Duties & Taxes" group that match CGST/SGST/IGST naming
 */
export async function resolveGSTLedgers(inputParams: Map<string, any>): Promise<{ cgst?: string; sgst?: string; igst?: string }> {
    const result: { cgst?: string; sgst?: string; igst?: string } = {};

    const listParams = new Map<string, any>([['collection', 'ledger']]);
    if (inputParams.has('targetCompany')) {
        listParams.set('targetCompany', inputParams.get('targetCompany'));
    }

    const resp = await handlePull('list-master', listParams);
    if (!resp.data || !Array.isArray(resp.data)) return result;

    const ledgerNames: string[] = resp.data.map((r: any) => r.name as string).filter(Boolean);

    // match common GST ledger naming patterns (case-insensitive)
    for (const name of ledgerNames) {
        const lower = name.toLowerCase();
        if (!result.cgst && (lower.includes('cgst') || lower.includes('central tax') || lower.includes('central gst'))) {
            result.cgst = name;
        }
        if (!result.sgst && (lower.includes('sgst') || lower.includes('state tax') || lower.includes('state gst') || lower.includes('utgst'))) {
            result.sgst = name;
        }
        if (!result.igst && (lower.includes('igst') || lower.includes('integrated tax') || lower.includes('integrated gst'))) {
            result.igst = name;
        }
    }

    return result;
}
