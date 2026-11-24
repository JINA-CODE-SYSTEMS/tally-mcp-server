// Test helper (not a test file): a fake Tally XML server on a random local port.
//
// pushXml / postTallyXML speak UTF-16LE over HTTP to TALLY_HOST:TALLY_PORT, read at call time, so pointing
// those two variables here lets a test drive the real write path — executeVoucher's pushXml included —
// without a Tally. Every request is answered by the test's own handler; an Export with no answer from the
// handler gets an empty envelope, which is enough for pingTally.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTally = {
  port: number;
  requests: string[];
  close(): Promise<void>;
};

export async function startFakeTally(handler: (xml: string) => string | undefined): Promise<FakeTally> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const xml = Buffer.concat(chunks).toString('utf16le');
      requests.push(xml);
      let body: string | undefined;
      try { body = handler(xml); } catch (e: any) { body = `<RESPONSE><ERRORS>1</ERRORS><LINEERROR>${String(e?.message ?? e)}</LINEERROR></RESPONSE>`; }
      res.writeHead(200, { 'Content-Type': 'text/xml;charset=utf-16' });
      res.end(Buffer.from(body ?? '<ENVELOPE></ENVELOPE>', 'utf16le'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  process.env.TALLY_HOST = '127.0.0.1';
  process.env.TALLY_PORT = String(port);
  return {
    port,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Tally's answer to a voucher import that created one voucher. */
export const importOk = (masterId: number) =>
  `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><LASTVCHID>${masterId}</LASTVCHID><ERRORS>0</ERRORS></RESPONSE>`;

/** Tally's answer to a rejected import. */
export const importRejected = (message: string) =>
  `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>${message}</LINEERROR></RESPONSE>`;

export const isImport = (xml: string) => /<TALLYREQUEST>\s*Import Data\s*<\/TALLYREQUEST>/i.test(xml);

/** The <VOUCHER>…</VOUCHER> block of an import request. */
export const voucherBlockOf = (xml: string) => (xml.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/) || [''])[0];
