import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

spec_path, out_path = sys.argv[1], sys.argv[2]
spec = json.load(open(spec_path, encoding="utf-8"))
geo = spec["geometry_mm"]
variants = sorted(spec["variants"], key=lambda v: v["code"])
ELIGIBLE = {"S": [0, 2, 4, 5, 7], "M": [0, 1, 2, 4, 5, 6, 7], "L": [0, 1, 2, 3, 4, 5, 6, 7]}
SIZE_NAME = {"S": "S (400)", "M": "M (600)", "L": "L (800)"}
PANELS = [  # panel, Gateway article, faces that meet a module
    ("Left side", "Left Side Panel - White (in Prepared Left Side Panel, RR-202609-DEFPG54X)", ["right"]),
    ("Mid panel", "Mid panel part not created yet (Prepared Mid Panel, RR-202609-7C4GCN8M)", ["left", "right"]),
    ("Right side", "Right Side Panel - White (in Prepared Right Side Panel, RR-202609-WWQTVTEA)", ["left"]),
]

def holds(v):
    c = v["content"]; parts = []
    if c.get("beautybox"): parts.append("BeautyBox unit")
    for s in c.get("shelves", []): parts.append(f"{s} at {geo['boards'][s]}")
    for r in c.get("rails", []): parts.append(f"{r['rail']} rail at {geo['rails'][r['rail']]} (hangs to {r['down_to']})")
    if c.get("drawers"):
        parts.append("2 drawers: " + ", ".join(f"{d['bottom']}–{d['top']}" for d in geo["drawers"][: c["drawers"]]))
    return "; ".join(parts) or "—"

F = "Arial"
font = Font(name=F, size=10); bold = Font(name=F, size=10, bold=True); head = Font(name=F, size=10, bold=True, color="FFFFFF")
title = Font(name=F, size=14, bold=True)
fill_head = PatternFill("solid", fgColor="2F4858"); fill_input = PatternFill("solid", fgColor="FFF2CC"); fill_ex = PatternFill("solid", fgColor="E2EFDA")
thin = Side(style="thin", color="D0D5DA"); border = Border(left=thin, right=thin, top=thin, bottom=thin)
wrap = Alignment(wrap_text=True, vertical="top")

wb = Workbook()

# ---- Read me
rm = wb.active; rm.title = "Read me"
rows = [
    ("Hub operations matrix — side panels", title),
    ("Which extra holes or milling each side panel needs at the hub, per module setting. Order Operations item 0039; the E&C Gateway defines, Order Operations executes (decision 0012).", font),
    ("", font),
    ("How it works", bold),
    ("1. Each row is one face of a side panel meeting one module, in one size and one interior. A mid panel has two faces, so it appears twice per setting.", font),
    ("2. Most rows are covered by the supplier's default drilling. Mark those 'Yes' and leave the rest of the row empty.", font),
    ("3. Where the hub must add holes or milling, mark 'No' and fill in Operation, Instruction and Drawing.", font),
    ("4. Each 'No' row becomes one operation on that side panel part in the E&C Gateway, with the condition in column K. After Resolve BOM, Order Operations matches each side panel in an order against its neighbouring modules and puts the matching operations on the order's work order.", font),
    ("5. If a pattern is the same for every size, fill it once and write 'same as L' in Notes on the S and M rows.", font),
    ("", font),
    ("Legend", bold),
    ("Yellow cells: fill in. Grey cells: from the planner's spec (spec/interior-variants.json), do not edit. Column K is a formula.", font),
    ("Heights are millimetres in the planner's 3D model (feet at 13.5, side bottom edge at about 20). Subtract about 20 mm to measure from the side panel's bottom edge.", font),
    ("Faces are as seen from the front: the left face of a panel meets the module to its left.", font),
    ("Article numbers are the White variants; the same operations apply to every colour unless Notes says otherwise.", font),
    ("", font),
    ("Example (not real data)", bold),
]
for i, (text, f) in enumerate(rows, 1):
    c = rm.cell(row=i, column=1, value=text); c.font = f; c.alignment = Alignment(wrap_text=True, vertical="top")
ex_head = ["Panel", "Face", "Size", "Interior", "Supplier default enough?", "Operation", "Instruction", "Drawing", "Condition"]
ex_vals = ["Mid panel", "left", "L", "1 Lådor + häng", "No", "drill", "Drill 4 runner holes Ø5×12 for the lower drawer pair", "DRW-0123 rev A", '{"face":"left","size":"L","interior":1}']
r0 = len(rows) + 1
for j, (h, v) in enumerate(zip(ex_head, ex_vals), 1):
    a = rm.cell(row=r0, column=j, value=h); a.font = bold; a.border = border
    b = rm.cell(row=r0 + 1, column=j, value=v); b.font = font; b.fill = fill_ex; b.border = border; b.alignment = wrap
rm.column_dimensions["A"].width = 110
for col in "BCDEFGHI": rm.column_dimensions[col].width = 18

# ---- Matrix
mx = wb.create_sheet("Side panel matrix")
headers = ["Panel", "Gateway article", "Face", "Module size", "Interior code", "Interior", "What the module holds (mm)",
           "Supplier default enough?", "Operation", "Instruction", "Condition (for the Gateway)", "Drawing", "Notes"]
widths = [12, 44, 7, 11, 9, 18, 60, 13, 12, 44, 38, 16, 30]
for j, (h, w) in enumerate(zip(headers, widths), 1):
    c = mx.cell(row=1, column=j, value=h); c.font = head; c.fill = fill_head; c.alignment = Alignment(wrap_text=True, vertical="center"); c.border = border
    mx.column_dimensions[c.column_letter].width = w
mx.freeze_panes = "H2"
r = 2
for panel, article, faces in PANELS:
    for face in faces:
        for size in ["S", "M", "L"]:
            for code in ELIGIBLE[size]:
                v = variants[code]
                vals = [panel, article, face, size, code, v["name_sv"], holds(v), None, None, None, None, None, None]
                for j, val in enumerate(vals, 1):
                    c = mx.cell(row=r, column=j, value=val); c.font = font; c.border = border; c.alignment = wrap
                    c.fill = fill_input if j in (8, 9, 10, 12, 13) else PatternFill("solid", fgColor="F2F2F2")
                k = mx.cell(row=r, column=11)
                k.value = f'=IF(H{r}="No","{{""face"":"""&C{r}&""",""size"":"""&D{r}&""",""interior"":"&E{r}&"}}","")'
                k.fill = PatternFill("solid", fgColor="FFFFFF")
                r += 1
last = r - 1
dv1 = DataValidation(type="list", formula1='"Yes,No,Unsure"', allow_blank=True); mx.add_data_validation(dv1); dv1.add(f"H2:H{last}")
dv2 = DataValidation(type="list", formula1='"drill,route,cut,insert,attach,surface_treat,inspect,other"', allow_blank=True); mx.add_data_validation(dv2); dv2.add(f"I2:I{last}")
mx.auto_filter.ref = f"A1:M{last}"
mx["H1"].comment = Comment("Yes: the supplier's predrilled panel already has every hole this module needs. No: the hub adds holes or milling.", "Order Operations")

# ---- Interior variants
iv = wb.create_sheet("Interior variants")
ih = ["Code", "Interior", "Sizes", "Shelves (height mm)", "Rails (height mm)", "Drawers", "Description"]
for j, h in enumerate(ih, 1):
    c = iv.cell(row=1, column=j, value=h); c.font = head; c.fill = fill_head; c.border = border
for i, v in enumerate(variants, 2):
    c = v["content"]
    sizes = ", ".join(s for s in "SML" if v["code"] in ELIGIBLE[s])
    vals = [v["code"], v["name_sv"], sizes,
            ", ".join(f"{s} {geo['boards'][s]}" for s in c.get("shelves", [])) or "—",
            ", ".join(f"{x['rail']} {geo['rails'][x['rail']]}" for x in c.get("rails", [])) or "—",
            c.get("drawers", 0), v.get("desc_sv", "")]
    for j, val in enumerate(vals, 1):
        cell = iv.cell(row=i, column=j, value=val); cell.font = font; cell.border = border; cell.alignment = wrap
for col, w in zip("ABCDEFG", [6, 18, 8, 40, 32, 8, 60]): iv.column_dimensions[col].width = w
n = len(variants) + 3
iv.cell(row=n, column=1, value="Fixed shelf 1 sits at 2055 in every interior; bottom board at 131. Source: valcyra-site spec/interior-variants.json (geometry_mm, measured from the GLB models 2026-10-08). Size rules: docs/wardrobe-blender-spec.md §5 (BeautyBox: L only, with a neighbour on both sides).").font = font

# ---- Summary
sm = wb.create_sheet("Summary")
sh = ["Panel", "Rows", "Answered", "Supplier default", "Hub work", "Hub rows without drawing"]
for j, h in enumerate(sh, 1):
    c = sm.cell(row=1, column=j, value=h); c.font = head; c.fill = fill_head; c.border = border
M = "'Side panel matrix'"
for i, (panel, _, _) in enumerate(PANELS, 2):
    sm.cell(row=i, column=1, value=panel)
    sm.cell(row=i, column=2, value=f'=COUNTIFS({M}!$A$2:$A${last},A{i})')
    sm.cell(row=i, column=3, value=f'=COUNTIFS({M}!$A$2:$A${last},A{i},{M}!$H$2:$H${last},"Yes")+COUNTIFS({M}!$A$2:$A${last},A{i},{M}!$H$2:$H${last},"No")')
    sm.cell(row=i, column=4, value=f'=COUNTIFS({M}!$A$2:$A${last},A{i},{M}!$H$2:$H${last},"Yes")')
    sm.cell(row=i, column=5, value=f'=COUNTIFS({M}!$A$2:$A${last},A{i},{M}!$H$2:$H${last},"No")')
    sm.cell(row=i, column=6, value=f'=COUNTIFS({M}!$A$2:$A${last},A{i},{M}!$H$2:$H${last},"No",{M}!$L$2:$L${last},"")')
t = len(PANELS) + 2
sm.cell(row=t, column=1, value="Total").font = bold
for j in range(2, 7):
    col = sm.cell(row=1, column=j).column_letter
    sm.cell(row=t, column=j, value=f"=SUM({col}2:{col}{t-1})").font = bold
for row in sm.iter_rows(min_row=2, max_row=t):
    for c in row:
        c.border = border
        if c.font != bold: c.font = font
for col, w in zip("ABCDEF", [14, 8, 10, 16, 10, 24]): sm.column_dimensions[col].width = w

wb.save(out_path)
print("rows", last - 1)
