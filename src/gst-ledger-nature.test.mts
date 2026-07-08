import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGstNature, pickGstLedgers } from './tally.mjs';

test('classifyGstNature reads output / input / neutral from the name', () => {
  assert.equal(classifyGstNature('Output IGST @18%'), 'output');
  assert.equal(classifyGstNature('IGST on Sales'), 'output');
  assert.equal(classifyGstNature('Input CGST'), 'input');
  assert.equal(classifyGstNature('IGST on Purchase'), 'input');
  assert.equal(classifyGstNature('ITC IGST'), 'input');
  assert.equal(classifyGstNature('IGST'), 'neutral');            // undifferentiated
  assert.equal(classifyGstNature('IGST Payable / Receivable'), 'neutral'); // names both → neutral
});

// The reported bug: a SALES voucher auto-picked INPUT IGST.
test('a sales (output) voucher never picks the input-tax ledger', () => {
  const ledgers = ['INPUT IGST', 'OUTPUT IGST', 'Cash'];
  assert.deepEqual(pickGstLedgers(ledgers, 'output'), { igst: 'OUTPUT IGST' });
  assert.deepEqual(pickGstLedgers(ledgers, 'input'), { igst: 'INPUT IGST' });
});

test('intra-state: cgst + sgst are each direction-matched', () => {
  const ledgers = ['Input CGST', 'Output CGST', 'Input SGST', 'Output SGST'];
  assert.deepEqual(pickGstLedgers(ledgers, 'output'), { cgst: 'Output CGST', sgst: 'Output SGST' });
  assert.deepEqual(pickGstLedgers(ledgers, 'input'),  { cgst: 'Input CGST',  sgst: 'Input SGST'  });
});

test('a neutral ledger is used when no nature-specific one exists', () => {
  assert.deepEqual(pickGstLedgers(['IGST @18%'], 'output'), { igst: 'IGST @18%' });
  assert.deepEqual(pickGstLedgers(['IGST @18%'], 'input'),  { igst: 'IGST @18%' });
});

test('fails closed: only an OPPOSITE-nature ledger exists → do NOT pick it', () => {
  // Sales voucher but only an input ledger present → leave igst undefined so the handler errors,
  // rather than booking output tax to an input ledger.
  assert.deepEqual(pickGstLedgers(['INPUT IGST'], 'output'), {});
  assert.deepEqual(pickGstLedgers(['OUTPUT IGST'], 'input'), {});
});

test('nature-match wins even when a neutral ledger appears first', () => {
  assert.deepEqual(pickGstLedgers(['IGST', 'Output IGST'], 'output'), { igst: 'Output IGST' });
});

test('no nature (legacy) → first token match, preserving old behaviour', () => {
  assert.deepEqual(pickGstLedgers(['INPUT IGST', 'OUTPUT IGST']), { igst: 'INPUT IGST' });
});

test('central/state/integrated wording is recognised as the right tax type', () => {
  const ledgers = ['Central Tax - Output', 'State Tax - Output', 'Integrated Tax - Output'];
  assert.deepEqual(pickGstLedgers(ledgers, 'output'), {
    cgst: 'Central Tax - Output', sgst: 'State Tax - Output', igst: 'Integrated Tax - Output',
  });
});
