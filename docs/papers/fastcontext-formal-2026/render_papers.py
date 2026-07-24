from __future__ import annotations

import argparse
import html
import re
from dataclasses import dataclass
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[3]
SOURCE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output" / "pdf"
CHINESE_FONT = Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf")
MONO_FONT = Path(r"C:\Windows\Fonts\consola.ttf")


@dataclass
class BibEntry:
    key: str
    fields: dict[str, str]


class AcademicDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, short_title: str, **kwargs):
        self.short_title = short_title
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="academic", frames=[frame], onPage=self.draw_page))

    def draw_page(self, canvas, document):
        canvas.saveState()
        page_width, page_height = A4
        canvas.setStrokeColor(colors.HexColor("#D1D5DB"))
        canvas.setLineWidth(0.45)
        canvas.line(document.leftMargin, page_height - 17 * mm, page_width - document.rightMargin, page_height - 17 * mm)
        canvas.setFillColor(colors.HexColor("#4B5563"))
        canvas.setFont("PaperSans", 7.5)
        canvas.drawString(document.leftMargin, page_height - 13.5 * mm, self.short_title)
        canvas.drawRightString(page_width - document.rightMargin, 11 * mm, str(document.page))
        canvas.restoreState()


def register_fonts() -> None:
    if not CHINESE_FONT.exists():
        raise FileNotFoundError(f"Chinese font not found: {CHINESE_FONT}")
    pdfmetrics.registerFont(TTFont("PaperSans", str(CHINESE_FONT)))
    if MONO_FONT.exists():
        pdfmetrics.registerFont(TTFont("PaperMono", str(MONO_FONT)))
    else:
        pdfmetrics.registerFont(TTFont("PaperMono", str(CHINESE_FONT)))


def parse_bibtex(path: Path) -> dict[str, BibEntry]:
    text = path.read_text(encoding="utf-8")
    entries: dict[str, BibEntry] = {}
    index = 0
    while index < len(text):
        match = re.search(r"@[A-Za-z]+\s*\{\s*([^,]+),", text[index:])
        if not match:
            break
        start = index + match.start()
        body_start = index + match.end()
        depth = 1
        cursor = body_start
        while cursor < len(text) and depth:
            if text[cursor] == "{":
                depth += 1
            elif text[cursor] == "}":
                depth -= 1
            cursor += 1
        key = match.group(1).strip()
        body = text[body_start:cursor - 1]
        fields: dict[str, str] = {}
        field_pattern = re.compile(r"(?ms)^\s*([A-Za-z]+)\s*=\s*\{(.*?)\}\s*,?\s*$")
        for field_match in field_pattern.finditer(body):
            value = re.sub(r"\s+", " ", field_match.group(2).strip())
            value = value.replace("\\`", "").replace("\\'", "")
            fields[field_match.group(1).lower()] = value
        entries[key] = BibEntry(key=key, fields=fields)
        index = cursor
    return entries


def collect_citation_order(text: str) -> list[str]:
    order: list[str] = []
    for group in re.findall(r"\[@([^\]]+)\]", text):
        for part in group.split(";"):
            key = part.strip().lstrip("@").split(",", 1)[0].strip()
            if key and key not in order:
                order.append(key)
    return order


def citation_replacer(order: list[str]):
    numbers = {key: index + 1 for index, key in enumerate(order)}

    def replace(match: re.Match[str]) -> str:
        citations = []
        for part in match.group(1).split(";"):
            key = part.strip().lstrip("@").split(",", 1)[0].strip()
            if key in numbers:
                citations.append(str(numbers[key]))
        return f"[{', '.join(citations)}]" if citations else match.group(0)

    return replace


def inline_markup(text: str, citation_order: list[str]) -> str:
    replaced = re.sub(r"\[@([^\]]+)\]", citation_replacer(citation_order), text)
    normalized = (replaced
        .replace(r"\(", "")
        .replace(r"\)", "")
        .replace(r"\subseteq", "⊆")
        .replace(r"\in", "∈"))
    escaped = html.escape(normalized, quote=False)
    escaped = re.sub(r"`([^`]+)`", r'<font name="PaperMono" color="#0F766E">\1</font>', escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", escaped)
    return escaped


def paragraph_styles(language: str):
    base = getSampleStyleSheet()
    leading = 17 if language == "zh" else 15.5
    body_size = 9.8 if language == "zh" else 9.5
    return {
        "title": ParagraphStyle(
            "PaperTitle",
            parent=base["Title"],
            fontName="PaperSans",
            fontSize=21,
            leading=29,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#111827"),
            spaceAfter=9 * mm,
        ),
        "meta": ParagraphStyle(
            "PaperMeta",
            fontName="PaperSans",
            fontSize=8.2,
            leading=12,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#4B5563"),
            spaceAfter=1.5 * mm,
        ),
        "h1": ParagraphStyle(
            "Heading1Paper",
            fontName="PaperSans",
            fontSize=14,
            leading=20,
            textColor=colors.HexColor("#111827"),
            spaceBefore=7 * mm,
            spaceAfter=2.8 * mm,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "Heading2Paper",
            fontName="PaperSans",
            fontSize=11.5,
            leading=17,
            textColor=colors.HexColor("#1F2937"),
            spaceBefore=4.5 * mm,
            spaceAfter=2 * mm,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "Heading3Paper",
            fontName="PaperSans",
            fontSize=10.3,
            leading=15,
            textColor=colors.HexColor("#374151"),
            spaceBefore=3.5 * mm,
            spaceAfter=1.5 * mm,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "BodyPaper",
            fontName="PaperSans",
            fontSize=body_size,
            leading=leading,
            alignment=TA_LEFT if language == "zh" else TA_JUSTIFY,
            textColor=colors.HexColor("#111827"),
            spaceAfter=2.8 * mm,
            firstLineIndent=5.5 * mm if language == "zh" else 0,
            allowWidows=0,
            allowOrphans=0,
        ),
        "abstract": ParagraphStyle(
            "AbstractPaper",
            fontName="PaperSans",
            fontSize=9.2,
            leading=15.2,
            alignment=TA_LEFT if language == "zh" else TA_JUSTIFY,
            textColor=colors.HexColor("#1F2937"),
            leftIndent=9 * mm,
            rightIndent=9 * mm,
            spaceAfter=4 * mm,
        ),
        "quote": ParagraphStyle(
            "QuotePaper",
            fontName="PaperSans",
            fontSize=8.9,
            leading=14,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#7F1D1D"),
            borderColor=colors.HexColor("#FCA5A5"),
            borderWidth=0.7,
            borderPadding=7,
            backColor=colors.HexColor("#FEF2F2"),
            spaceBefore=2 * mm,
            spaceAfter=3 * mm,
        ),
        "list": ParagraphStyle(
            "ListPaper",
            fontName="PaperSans",
            fontSize=body_size,
            leading=leading,
            textColor=colors.HexColor("#111827"),
            leftIndent=7 * mm,
            firstLineIndent=-5 * mm,
            spaceAfter=1.2 * mm,
        ),
        "reference": ParagraphStyle(
            "ReferencePaper",
            fontName="PaperSans",
            fontSize=8.2,
            leading=12.3,
            leftIndent=7 * mm,
            firstLineIndent=-7 * mm,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#1F2937"),
            spaceAfter=1.8 * mm,
        ),
        "table": ParagraphStyle(
            "TablePaper",
            fontName="PaperSans",
            fontSize=6.4,
            leading=8.2,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#111827"),
        ),
        "table_header": ParagraphStyle(
            "TableHeaderPaper",
            fontName="PaperSans",
            fontSize=6.4,
            leading=8.2,
            alignment=TA_LEFT,
            textColor=colors.white,
        ),
    }


def bibliography_text(entry: BibEntry) -> str:
    fields = entry.fields
    parts = []
    if fields.get("author"):
        parts.append(fields["author"].replace(" and ", ", "))
    if fields.get("title"):
        parts.append(f'“{fields["title"]}”')
    venue = fields.get("booktitle") or fields.get("journal") or fields.get("howpublished")
    if venue:
        parts.append(venue)
    if fields.get("volume"):
        parts.append(f'vol. {fields["volume"]}')
    if fields.get("pages"):
        parts.append(f'pp. {fields["pages"]}')
    if fields.get("year"):
        parts.append(fields["year"])
    if fields.get("doi"):
        parts.append(f'DOI: {fields["doi"]}')
    elif fields.get("url"):
        parts.append(fields["url"])
    return ". ".join(part.rstrip(".") for part in parts if part) + "."


def parse_markdown(path: Path, language: str, bibliography: dict[str, BibEntry]):
    text = path.read_text(encoding="utf-8")
    citation_order = collect_citation_order(text)
    styles = paragraph_styles(language)
    story = []
    lines = text.splitlines()
    paragraph_lines: list[str] = []
    list_items: list[tuple[str, str]] = []
    table_lines: list[str] = []
    abstract_heading = "摘要" if language == "zh" else "Abstract"
    references_heading = "参考文献" if language == "zh" else "References"
    current_section = ""

    def flush_paragraph():
        nonlocal paragraph_lines
        if not paragraph_lines:
            return
        content = " ".join(part.strip() for part in paragraph_lines)
        style = styles["abstract"] if current_section == abstract_heading else styles["body"]
        story.append(Paragraph(inline_markup(content, citation_order), style))
        paragraph_lines = []

    def flush_list():
        nonlocal list_items
        if not list_items:
            return
        for marker, content in list_items:
            visible_marker = marker if marker.endswith(".") else "•"
            story.append(Paragraph(
                f"{visible_marker}&nbsp;&nbsp;{inline_markup(content, citation_order)}",
                styles["list"],
            ))
        story.append(Spacer(1, 1.8 * mm))
        list_items = []

    def flush_table():
        nonlocal table_lines
        if not table_lines:
            return
        parsed_rows = []
        for table_line in table_lines:
            cells = [cell.strip() for cell in table_line.strip().strip("|").split("|")]
            if cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
                continue
            parsed_rows.append(cells)
        if not parsed_rows:
            table_lines = []
            return
        column_count = max(len(row) for row in parsed_rows)
        normalized_rows = [row + [""] * (column_count - len(row)) for row in parsed_rows]
        available_width = 166 * mm
        if column_count >= 7:
            first_width = 24 * mm
        elif column_count >= 4:
            first_width = 38 * mm
        else:
            first_width = available_width / column_count
        remaining_width = available_width - first_width
        column_widths = [first_width] + ([remaining_width / (column_count - 1)] * (column_count - 1) if column_count > 1 else [])
        flowable_rows = []
        for row_index, row in enumerate(normalized_rows):
            style = styles["table_header"] if row_index == 0 else styles["table"]
            flowable_rows.append([Paragraph(inline_markup(cell, citation_order), style) for cell in row])
        table = Table(flowable_rows, colWidths=column_widths, repeatRows=1, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#374151")),
            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#F9FAFB")),
            ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D1D5DB")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(table)
        story.append(Spacer(1, 3 * mm))
        table_lines = []

    for line_index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            flush_paragraph()
            flush_list()
            table_lines.append(stripped)
            continue
        flush_table()
        if line_index == 0 and stripped.startswith("# "):
            story.append(Paragraph(inline_markup(stripped[2:], citation_order), styles["title"]))
            story.append(HRFlowable(width="30%", thickness=1.2, color=colors.HexColor("#0F766E"), spaceAfter=5 * mm, hAlign="CENTER"))
            continue
        if stripped.startswith("**Manuscript status:") or stripped.startswith("**稿件状态：") or stripped.startswith("**FastContext") or stripped.startswith("**Experiment") or stripped.startswith("**实验"):
            flush_paragraph()
            flush_list()
            story.append(Paragraph(inline_markup(stripped.rstrip("  "), citation_order), styles["meta"]))
            continue
        heading = re.match(r"^(#{2,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1)) - 1
            title = heading.group(2)
            current_section = title
            if title == references_heading:
                break
            story.append(Paragraph(inline_markup(title, citation_order), styles[f"h{min(level, 3)}"]))
            continue
        list_match = re.match(r"^([-*]|\d+\.)\s+(.+)$", stripped)
        if list_match:
            flush_paragraph()
            list_items.append((list_match.group(1), list_match.group(2)))
            continue
        if stripped.startswith("> "):
            flush_paragraph()
            flush_list()
            story.append(Paragraph(inline_markup(stripped[2:], citation_order), styles["quote"]))
            continue
        if not stripped:
            flush_paragraph()
            flush_list()
            continue
        paragraph_lines.append(stripped)

    flush_paragraph()
    flush_list()
    flush_table()
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(references_heading, styles["h1"]))
    for index, key in enumerate(citation_order, start=1):
        entry = bibliography.get(key)
        content = bibliography_text(entry) if entry else f"Unresolved bibliography key: {key}."
        story.append(Paragraph(f"[{index}] {html.escape(content)}", styles["reference"]))
    return story


def render(source: Path, output: Path, language: str, bibliography: dict[str, BibEntry]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    short_title = "FastContext - Repository-Level Code Localization"
    document = AcademicDocTemplate(
        str(output),
        short_title=short_title,
        pagesize=A4,
        leftMargin=22 * mm,
        rightMargin=22 * mm,
        topMargin=23 * mm,
        bottomMargin=19 * mm,
        title=source.stem,
        author="TurboFlux Research",
    )
    document.build(parse_markdown(source, language, bibliography))


def main() -> None:
    parser = argparse.ArgumentParser(description="Render FastContext bilingual academic preprints.")
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument("--source-dir", default=str(SOURCE_DIR))
    parser.add_argument("--final", action="store_true")
    arguments = parser.parse_args()

    register_fonts()
    source_directory = Path(arguments.source_dir).resolve()
    bibliography_path = source_directory / "references.bib"
    if not bibliography_path.exists():
        bibliography_path = SOURCE_DIR / "references.bib"
    bibliography = parse_bibtex(bibliography_path)
    output_directory = Path(arguments.output_dir).resolve()
    suffix = "" if arguments.final else "-Draft"
    source_suffix = "-final" if arguments.final else ""
    outputs = [
        (source_directory / f"paper-zh{source_suffix}.md", output_directory / f"FastContext-Formal-Paper-ZH{suffix}.pdf", "zh"),
        (source_directory / f"paper-en{source_suffix}.md", output_directory / f"FastContext-Formal-Paper-EN{suffix}.pdf", "en"),
    ]
    for source, output, language in outputs:
        if not source.exists():
            raise FileNotFoundError(f"Paper source not found: {source}")
        render(source, output, language, bibliography)
        print(output)


if __name__ == "__main__":
    main()
