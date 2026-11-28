// Pure xlsx worksheet-XML → text extraction, shared by portal-ai (Deno) and
// tests (Node), following the cost-math.mjs pattern. No imports, no I/O: the
// caller unzips and hands over XML strings.
//
// Why not just read sharedStrings.xml: numbers (prices!) are stored per-cell
// in the sheet XML, never in the shared-string table — and many generators
// (ClosedXML/EPPlus-style, with x: namespace prefixes) write every string
// inline and leave sharedStrings.xml empty, which made imports extract
// nothing at all.

function xmlDecode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}

function textRuns(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((m) => xmlDecode(m[1])).join("");
}

// sharedStringsXml: contents of xl/sharedStrings.xml ("" if absent).
// sheetXmls: contents of xl/worksheets/sheet*.xml, in sheet order.
// Returns one line per non-empty row, cells joined with " | ".
export function sheetTextFromXlsxParts({ sharedStringsXml = "", sheetXmls = [] }) {
  const shared = [...sharedStringsXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)]
    .map((m) => textRuns(m[1]));

  const out = [];
  for (const xml of sheetXmls) {
    for (const row of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = c[1] || "", inner = c[2] || "";
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        let v = "";
        if (type === "inlineStr") {
          v = textRuns(inner);
        } else {
          const m = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
          v = m ? xmlDecode(m[1]) : "";
          if (type === "s") v = shared[Number(v)] ?? "";
          if (type === "b") v = v === "1" ? "TRUE" : "FALSE";
        }
        cells.push(v.replace(/\s+/g, " ").trim());
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) out.push(cells.join(" | "));
    }
  }
  return out.join("\n").trim();
}
