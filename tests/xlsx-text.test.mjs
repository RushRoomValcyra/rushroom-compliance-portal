// PROP-074 — xlsx text extraction for cost imports.
// The old extractor read only xl/sharedStrings.xml: numbers (prices) never
// live there, and generators that write strings inline (x:-prefixed
// ClosedXML/EPPlus style) leave it empty — a real supplier quotation
// imported as "(empty)". These tests pin both document shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { sheetTextFromXlsxParts } from "../supabase/functions/_shared/xlsx-text.mjs";

test("inline-string workbook with empty sharedStrings (x:-prefixed, the failing supplier quotation shape)", () => {
  const sharedStringsXml = '<?xml version="1.0"?><x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" />';
  const sheet = `<x:worksheet xmlns:x="ns"><x:sheetData>
    <x:row r="1"><x:c r="A1" s="3" t="str"><x:v>VALCYRA — Component prices</x:v></x:c><x:c r="B1" s="2" /></x:row>
    <x:row r="2"><x:c r="A2" t="str"><x:v>SIDE PANEL LEFT</x:v></x:c><x:c r="B2"><x:v>50</x:v></x:c><x:c r="C2"><x:v>17.46</x:v></x:c></x:row>
    <x:row r="3"><x:c r="A3" s="2" /><x:c r="B3" s="2" /></x:row>
  </x:sheetData></x:worksheet>`;
  const text = sheetTextFromXlsxParts({ sharedStringsXml, sheetXmls: [sheet] });
  assert.equal(text, "VALCYRA — Component prices\nSIDE PANEL LEFT | 50 | 17.46");
});

test("Excel-authored workbook: shared refs, rich text, numbers, inline strings, booleans", () => {
  const sharedStringsXml = `<sst count="3" uniqueCount="3">
    <si><t>Part</t></si>
    <si><r><rPr><b/></rPr><t>Side</t></r><r><t xml:space="preserve"> panel</t></r></si>
    <si><t>Unit cost &amp; freight</t></si>
  </sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>17.46</v></c><c r="C2" t="b"><v>1</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>PLINTH S</t></is></c><c r="B3"><v>2.13</v></c></row>
  </sheetData></worksheet>`;
  const text = sheetTextFromXlsxParts({ sharedStringsXml, sheetXmls: [sheet] });
  assert.equal(text, "Part | Unit cost & freight\nSide panel | 17.46 | TRUE\nPLINTH S | 2.13");
});

test("multiple sheets concatenate in the given order; empty workbook gives empty text", () => {
  const s1 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row></sheetData></worksheet>';
  const s2 = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row></sheetData></worksheet>';
  assert.equal(sheetTextFromXlsxParts({ sharedStringsXml: "", sheetXmls: [s1, s2] }), "first\nsecond");
  assert.equal(sheetTextFromXlsxParts({ sharedStringsXml: "", sheetXmls: [] }), "");
  assert.equal(sheetTextFromXlsxParts({ sharedStringsXml: "", sheetXmls: ['<worksheet><sheetData/></worksheet>'] }), "");
});
