from __future__ import annotations

import html
import json
import re
from pathlib import Path

from reportlab.graphics import renderSVG
from reportlab.graphics.shapes import Drawing, Line, Path as ShapePath, Polygon, Rect, String
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
    FrameBreak,
    KeepTogether,
    ListFlowable,
    ListItem,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).with_name("paper.md")
FIGURE_DIR = Path(__file__).with_name("figures")
OUTPUT_DIR = ROOT / "output" / "pdf"
OUTPUT_PDF = OUTPUT_DIR / "FastContext-Architecture-Paper-ZH-v1.1.pdf"
MANIFEST = Path(__file__).with_name("artifact-manifest.json")

SIMSUN = Path("C:/Windows/Fonts/simsun.ttc")
SIMHEI = Path("C:/Windows/Fonts/simhei.ttf")
NOTO = Path("C:/Windows/Fonts/NotoSansSC-VF.ttf")
ARIAL = Path("C:/Windows/Fonts/arial.ttf")
ARIAL_BOLD = Path("C:/Windows/Fonts/arialbd.ttf")
TIMES = Path("C:/Windows/Fonts/times.ttf")
TIMES_ITALIC = Path("C:/Windows/Fonts/timesi.ttf")
TIMES_BOLD = Path("C:/Windows/Fonts/timesbd.ttf")
CONSOLAS = Path("C:/Windows/Fonts/consola.ttf")


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("SimSun", str(SIMSUN), subfontIndex=0))
    pdfmetrics.registerFont(TTFont("SimHei", str(SIMHEI)))
    pdfmetrics.registerFont(TTFont("NotoSansSC", str(NOTO)))
    pdfmetrics.registerFont(TTFont("ArialEmbedded", str(ARIAL)))
    pdfmetrics.registerFont(TTFont("ArialEmbedded-Bold", str(ARIAL_BOLD)))
    pdfmetrics.registerFont(TTFont("TimesEmbedded", str(TIMES)))
    pdfmetrics.registerFont(TTFont("TimesEmbedded-Italic", str(TIMES_ITALIC)))
    pdfmetrics.registerFont(TTFont("TimesEmbedded-Bold", str(TIMES_BOLD)))
    pdfmetrics.registerFont(TTFont("ConsolasEmbedded", str(CONSOLAS)))


INK = colors.HexColor("#202124")
MUTED = colors.HexColor("#5F6368")
RULE = colors.HexColor("#C9CED6")
PINK = colors.HexColor("#F7D9DE")
BLUE = colors.HexColor("#CFE8F3")
PEACH = colors.HexColor("#F4DFC4")
YELLOW = colors.HexColor("#ECE9B8")
GREEN = colors.HexColor("#D7EBD9")
LAVENDER = colors.HexColor("#DCDFF0")
PANEL = colors.HexColor("#F5F6F7")
ACCENT = colors.HexColor("#B55236")


def arrow(d: Drawing, x1: float, y1: float, x2: float, y2: float, width: float = 1.1) -> None:
    d.add(Line(x1, y1, x2, y2, strokeColor=INK, strokeWidth=width))
    dx, dy = x2 - x1, y2 - y1
    length = max((dx * dx + dy * dy) ** 0.5, 0.001)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    size = 4.5
    d.add(Polygon([
        x2, y2,
        x2 - ux * size + px * size * 0.55,
        y2 - uy * size + py * size * 0.55,
        x2 - ux * size - px * size * 0.55,
        y2 - uy * size - py * size * 0.55,
    ], fillColor=INK, strokeColor=INK))


def box(
    d: Drawing,
    x: float,
    y: float,
    w: float,
    h: float,
    label: str,
    fill: colors.Color,
    font_size: float = 7.2,
    bold: bool = False,
    radius: float = 4,
) -> None:
    d.add(Rect(x, y, w, h, rx=radius, ry=radius, fillColor=fill, strokeColor=INK, strokeWidth=1.15))
    lines = label.split("\n")
    leading = font_size + 1.4
    base = y + h / 2 + (len(lines) - 1) * leading / 2 - font_size * 0.35
    for index, line in enumerate(lines):
        d.add(String(
            x + w / 2,
            base - index * leading,
            line,
            fontName="ArialEmbedded-Bold" if bold else "ArialEmbedded",
            fontSize=font_size,
            fillColor=INK,
            textAnchor="middle",
        ))


def label(d: Drawing, x: float, y: float, text: str, size: float = 7, bold: bool = False, anchor: str = "middle") -> None:
    d.add(String(
        x,
        y,
        text,
        fontName="ArialEmbedded-Bold" if bold else "ArialEmbedded",
        fontSize=size,
        fillColor=INK if bold else MUTED,
        textAnchor=anchor,
    ))


def loop_bracket(d: Drawing, x: float, y: float, h: float, side: str, text: str) -> None:
    direction = -1 if side == "left" else 1
    path = ShapePath()
    path.moveTo(x, y)
    path.lineTo(x + 7 * direction, y)
    path.lineTo(x + 7 * direction, y + h)
    path.lineTo(x, y + h)
    path.strokeColor = INK
    path.strokeWidth = 1.2
    path.fillColor = None
    d.add(path)
    label(d, x + 13 * direction, y + h / 2 - 2, text, 7, False)


def architecture_figure() -> Drawing:
    d = Drawing(246, 330)
    label(d, 123, 317, "Compact evidence enters primary context once", 7.2, True)
    box(d, 78, 286, 90, 22, "FAST_CONTEXT_PACK", GREEN, 7.0, True)

    box(d, 16, 232, 92, 38, "Primary Agent\nmodel and tool loop", PEACH, 7.1, True)
    box(d, 138, 232, 92, 38, "FastContext\nread-only subagent", PEACH, 7.1, True)
    arrow(d, 184, 270, 150, 286)
    arrow(d, 123, 286, 62, 270)

    box(d, 20, 179, 84, 30, "Context assembly\nconversation + policy", BLUE, 6.8)
    box(d, 142, 179, 84, 30, "Evidence gate\nread-grounded report", YELLOW, 6.8)
    arrow(d, 62, 209, 62, 232)
    arrow(d, 184, 209, 184, 232)

    box(d, 20, 128, 84, 30, "Execution tools\nwrite / shell / approval", BLUE, 6.5)
    box(d, 142, 128, 84, 30, "Read-only tools\nsearch / symbol / read", BLUE, 6.5)
    arrow(d, 62, 158, 62, 179)
    arrow(d, 184, 158, 184, 179)

    box(d, 20, 78, 84, 28, "Main run state\nCtrl+C / steering", LAVENDER, 6.7)
    box(d, 142, 78, 84, 28, "Independent task\nID / timeout / transcript", LAVENDER, 6.5)
    arrow(d, 62, 106, 62, 128)
    arrow(d, 184, 106, 184, 128)

    box(d, 78, 28, 90, 28, "Workspace + objective", PINK, 7.0, True)
    arrow(d, 102, 56, 62, 78)
    arrow(d, 144, 56, 184, 78)

    d.add(Line(123, 67, 123, 222, strokeColor=RULE, strokeWidth=0.8, strokeDashArray=[3, 3]))
    label(d, 123, 215, "raw trace boundary", 6.3)
    loop_bracket(d, 10, 122, 93, "left", "N x")
    loop_bracket(d, 236, 122, 93, "right", "N x")
    label(d, 62, 10, "interactive control plane", 6.3)
    label(d, 184, 10, "isolated retrieval plane", 6.3)
    return d


def cover_figure() -> Drawing:
    d = Drawing(438, 190)
    label(d, 219, 178, "GRAPHICAL ABSTRACT", 7.5, True)
    box(d, 4, 78, 82, 42, "Objective\n+ workspace", PINK, 8.0, True)
    box(d, 112, 78, 82, 42, "Model plans\nsearch hypotheses", PEACH, 7.4, True)
    box(d, 220, 78, 82, 42, "Local tools\nsearch + read", BLUE, 7.4, True)
    box(d, 328, 78, 82, 42, "Structured submit\ngrounded map", YELLOW, 7.2, True)
    arrow(d, 86, 99, 112, 99)
    arrow(d, 194, 99, 220, 99)
    arrow(d, 302, 99, 328, 99)
    d.add(Line(153, 63, 153, 39, strokeColor=INK, strokeWidth=1.0))
    d.add(Line(153, 39, 369, 39, strokeColor=INK, strokeWidth=1.0))
    arrow(d, 369, 39, 369, 78)
    label(d, 261, 27, "iterate until the coverage contract passes", 7.0)
    box(d, 125, 137, 188, 24, "Independent background task", LAVENDER, 7.6, True)
    arrow(d, 219, 137, 219, 120)
    label(d, 45, 5, "Primary agent remains interactive", 6.8, True, "start")
    label(d, 410, 5, "raw trace stays isolated", 6.8, True, "end")
    return d


def retrieval_figure() -> Drawing:
    d = Drawing(246, 315)
    box(d, 69, 279, 108, 24, "SUBMITTED_CODE_MAP", GREEN, 7.0, True)
    box(d, 53, 229, 140, 32, "Mechanical verifier\nread-covered path ranges", YELLOW, 6.8)
    arrow(d, 123, 261, 123, 279)
    box(d, 53, 179, 140, 32, "Evidence ledger\npath : line range : role", LAVENDER, 6.8)
    arrow(d, 123, 211, 123, 229)
    box(d, 16, 118, 62, 36, "search_content\nsearch_files", BLUE, 6.3)
    box(d, 92, 118, 62, 36, "search_symbols\ntrace_symbol", BLUE, 6.3)
    box(d, 168, 118, 62, 36, "read_file\nbounded ranges", BLUE, 6.3)
    arrow(d, 47, 154, 91, 179)
    arrow(d, 123, 154, 123, 179)
    arrow(d, 199, 154, 155, 179)
    box(d, 53, 62, 140, 34, "Hypothesis planner\nlexical + owner + runtime", PEACH, 6.8, True)
    arrow(d, 88, 96, 47, 118)
    arrow(d, 123, 96, 123, 118)
    arrow(d, 158, 96, 199, 118)
    box(d, 69, 15, 108, 24, "Objective + contract", PINK, 7.1, True)
    arrow(d, 123, 39, 123, 62)
    loop_bracket(d, 10, 55, 163, "left", "1..T")
    d.add(Line(205, 226, 236, 226, strokeColor=INK, strokeWidth=1.0))
    d.add(Line(236, 226, 236, 78, strokeColor=INK, strokeWidth=1.0))
    arrow(d, 236, 78, 193, 78)
    label(d, 239, 157, "recover", 6.2, False, "start")
    return d


def lifecycle_figure() -> Drawing:
    d = Drawing(246, 275)
    label(d, 123, 262, "Independent background lifecycle", 7.4, True)
    box(d, 79, 224, 88, 22, "REQUEST", PINK, 7.1, True)
    box(d, 8, 176, 66, 28, "UNAVAILABLE\nno workspace", PANEL, 6.5)
    box(d, 90, 176, 66, 28, "STARTED\nnew task ID", GREEN, 6.5)
    box(d, 172, 176, 66, 28, "RUNNING / BUSY\ndeduplicated", YELLOW, 6.2)
    arrow(d, 97, 224, 41, 204)
    arrow(d, 123, 224, 123, 204)
    arrow(d, 149, 224, 205, 204)

    box(d, 77, 116, 92, 34, "MODEL-DIRECTED LOOP\nseparate AbortController", PEACH, 6.6, True)
    arrow(d, 123, 176, 123, 150)
    arrow(d, 205, 176, 169, 144)

    box(d, 4, 55, 54, 28, "COMPLETED\npack ready", GREEN, 6.1)
    box(d, 65, 55, 54, 28, "FAILED\nerror", colors.HexColor("#F3D3CF"), 6.1)
    box(d, 126, 55, 54, 28, "STOPPED\nexplicit cancel", LAVENDER, 5.8)
    box(d, 187, 55, 54, 28, "TIMEOUT\nabort + fail", YELLOW, 6.0)
    arrow(d, 98, 116, 31, 83)
    arrow(d, 115, 116, 92, 83)
    arrow(d, 132, 116, 153, 83)
    arrow(d, 149, 116, 214, 83)

    d.add(Line(10, 23, 236, 23, strokeColor=RULE, strokeWidth=0.8))
    label(d, 10, 10, "Primary Ctrl+C", 6.2, True, "start")
    arrow(d, 62, 12, 107, 12)
    label(d, 111, 10, "primary run only", 6.2, False, "start")
    label(d, 236, 10, "no parent-abort edge", 6.2, True, "end")
    return d


def pilot_figure() -> Drawing:
    d = Drawing(246, 190)
    metrics = [
        ("End-to-end Q", 94.8, 69.9),
        ("Success-only Q", 94.8, 93.2),
        ("Success rate", 100.0, 75.0),
    ]
    left, base, chart_h = 82, 36, 116
    d.add(Line(left, base, left, base + chart_h, strokeColor=INK, strokeWidth=1))
    d.add(Line(left, base, 230, base, strokeColor=INK, strokeWidth=1))
    for tick in [0, 25, 50, 75, 100]:
        y = base + chart_h * tick / 100
        d.add(Line(left - 3, y, 230, y, strokeColor=RULE, strokeWidth=0.55))
        label(d, left - 7, y - 2, str(tick), 5.8, False, "end")
    colors_pair = [ACCENT, colors.HexColor("#657B83")]
    for idx, (name, tf, cc) in enumerate(metrics):
        x = left + 15 + idx * 47
        for offset, value, color in [(0, tf, colors_pair[0]), (13, cc, colors_pair[1])]:
            h = chart_h * value / 100
            d.add(Rect(x + offset, base, 10, h, fillColor=color, strokeColor=None))
            label(d, x + offset + 5, base + h + 3, f"{value:g}", 5.6)
        for line_index, line in enumerate(name.split(" ")):
            label(d, x + 11, 23 - line_index * 7, line, 5.4)
    d.add(Rect(88, 166, 8, 8, fillColor=colors_pair[0], strokeColor=None))
    label(d, 100, 166, "Historical FastContext", 6.1, False, "start")
    d.add(Rect(174, 166, 8, 8, fillColor=colors_pair[1], strokeColor=None))
    label(d, 186, 166, "Claude Code", 6.1, False, "start")
    label(d, 123, 3, "Pilot only: old commit, eight tasks, one run per task", 5.8, True)
    return d


FIGURES = {
    "architecture": (architecture_figure, "图 1. FastContext 双上下文架构。模型驱动检索平面与主交互平面共享工作区工具，但原始轨迹隔离，仅紧凑证据包单向进入主上下文。"),
    "retrieval": (retrieval_figure, "图 2. 模型驱动检索与证据门控。循环具有固定资源上界；模型自适应选择查询并提交候选和关系，本地只验证引用区间由本轮读取完整覆盖。"),
    "lifecycle": (lifecycle_figure, "图 3. 后台生命周期。主会话 Ctrl+C 与 FastContext 控制器之间不存在父中断边；显式取消、销毁和硬超时仍可终止任务。"),
    "pilot": (pilot_figure, "图 4. 历史先导实验。数据来自已删除自动预扫描的旧提交，仅用于描述历史观察，不代表当前系统。"),
}


TABLES = {
    "reference": (
        ["来源", "采用的思想", "FastContext 的差异"],
        [
            ["ReAct / Toolformer", "模型决定工具与参数，并根据观察迭代", "只读代码工具；结构化终态提交"],
            ["Self-RAG / Repoformer", "按需、选择性检索，避免固定无效上下文", "无预扫描和固定调用次数"],
            ["AutoCodeRover / LocAgent", "符号与代码关系驱动的迭代、多跳定位", "按需 trace_symbol，不建设常驻图索引"],
            ["Claude Code Explore", "独立上下文、只读、继承模型", "单一架构探索合同；读取区间核验"],
            ["OpenCode TaskTool", "child session、后台 Job、取消与完成通知", "进程内 RuntimeTask + JSONL transcript + 一次性 pack"],
        ],
        [47, 89, 105],
    ),
    "branches": (
        ["条件", "返回/动作", "主 Agent", "终止机制"],
        [
            ["空目标或无工作区", "unavailable", "继续定向工具或提示工作区", "无任务"],
            ["同目标已运行", "running + taskId", "不重复派遣", "原任务控制器"],
            ["不同目标已运行", "busy + active objective", "避免重叠检索", "原任务控制器"],
            ["新目标", "started + taskId", "立即继续，不 await", "cancel/destroy/timeout"],
            ["报告合格", "completed + pack", "下一模型轮次一次性注入", "自动清槽"],
            ["模型/门控失败", "failed", "显示 warning，使用定向工具", "自动清槽"],
        ],
        [58, 54, 76, 53],
    ),
    "contract": (
        ["轮次上界", "并行上界", "完成合同", "推理", "总时限"],
        [
            ["10", "8", "架构关系 + 变更影响边界", "high", "600 s"],
        ],
        [45, 45, 95, 48, 45],
    ),
    "modules": (
        ["模块", "职责", "关键技术"],
        [
            ["agentEngine.ts", "入口、去重、generation、pack 注入", "Promise 槽；独立 AbortController"],
            ["fastContextSubagent.ts", "事件映射、证据隔离、紧凑代码图", "无语义 fallback；5,000 字符上限"],
            ["subAgent.ts", "模型循环、结构化提交、工具执行、范围核验", "ReAct；trace_symbol 并行查询"],
            ["SubAgentTaskManager", "后台任务、超时、JSONL transcript", "Promise.race；append-only journal"],
            ["RuntimeTaskManager", "统一运行状态与 stop control", "状态机；事件发布"],
            ["NodeToolExecutor", "搜索、符号、读取、sandbox", "ripgrep；路径约束；目录排除"],
            ["FastContext UI", "阶段、worker、证据和摘要", "80 ms 批处理；120 事件环形窗口"],
        ],
        [65, 91, 85],
    ),
    "pilot": (
        ["指标", "旧 FastContext", "Claude Code", "解释"],
        [
            ["成功率", "100%", "75%", "Claude 两次 240 s 超时"],
            ["Recall@10", "0.927", "0.677", "失败运行计 0"],
            ["MRR", "1.000", "0.750", "失败运行计 0"],
            ["端到端 Q", "94.8", "69.9", "自定义复合指数"],
            ["成功案例 Q", "94.8", "93.2", "质量接近"],
            ["成功延迟 p50", "66.8 s", "107.0 s", "单轮观察"],
            ["成功延迟 p95", "107.0 s", "208.7 s", "非统计估计"],
        ],
        [59, 47, 47, 88],
    ),
}


ALGORITHMS = {
    "schedule": [
        "Algorithm 1  StartFastContext(q)",
        "1: q <- trim(q)",
        "2: if q is empty or workspace is absent: return UNAVAILABLE",
        "3: if activePromise exists and activeObjective = q: return RUNNING",
        "4: if activePromise exists: return BUSY(activeObjective)",
        "5: controller <- new AbortController()  // not linked to primary run",
        "6: generation <- generation + 1",
        "7: task <- Runtime.start(kind=fast_context, timeout=600 s)",
        "8: activePromise <- task.run(ModelDirectedRetrieve(q))",
        "9: on settle: clear slot iff activePromise identity still matches",
        "10: return STARTED(task.id)",
    ],
    "retrieve": [
        "Algorithm 2  ModelDirectedRetrieve(q)",
        "1: messages <- [system(architecture contract), user(q)]",
        "2: evidence <- empty read ledger; report <- none",
        "3: for turn = 1..10:",
        "4:   response <- model(messages, read-only tools)",
        "5:   if response has tool calls:",
        "6:      execute at most 8 calls concurrently",
        "7:      append observations; normalize and deduplicate evidence",
        "8:      continue",
        "9:   if no read evidence: request targeted reads",
        "10:  if submit_code_map is not read-grounded: reject once",
        "11:  else return deterministic RANKED_CODE_MAP rendering",
        "12: return FAILED or TRUNCATED with explicit uncertainty",
    ],
}


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "PaperTitle", parent=base["Title"], fontName="SimHei", fontSize=20,
            leading=28, alignment=TA_CENTER, textColor=INK, spaceAfter=9,
        ),
        "en_title": ParagraphStyle(
            "EnglishTitle", parent=base["Title"], fontName="TimesEmbedded-Bold", fontSize=12,
            leading=16, alignment=TA_CENTER, textColor=MUTED, spaceAfter=14,
        ),
        "author": ParagraphStyle(
            "Author", fontName="NotoSansSC", fontSize=9.5, leading=14,
            alignment=TA_CENTER, textColor=INK, spaceAfter=4,
        ),
        "meta": ParagraphStyle(
            "Meta", fontName="NotoSansSC", fontSize=7.5, leading=11,
            alignment=TA_CENTER, textColor=MUTED,
        ),
        "h2": ParagraphStyle(
            "H2", fontName="SimHei", fontSize=10.2, leading=13,
            textColor=INK, spaceBefore=8, spaceAfter=4, keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "H3", fontName="SimHei", fontSize=8.5, leading=11,
            textColor=ACCENT, spaceBefore=6, spaceAfter=3, keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "Body", fontName="NotoSansSC", fontSize=7.35, leading=10.7,
            alignment=TA_LEFT, textColor=INK, firstLineIndent=13,
            spaceAfter=4.2, allowWidows=0, allowOrphans=0, splitLongWords=True,
        ),
        "abstract": ParagraphStyle(
            "Abstract", fontName="NotoSansSC", fontSize=7.15, leading=10.3,
            alignment=TA_LEFT, textColor=INK, firstLineIndent=0,
            leftIndent=6, rightIndent=6, spaceAfter=4,
        ),
        "abstract_en": ParagraphStyle(
            "AbstractEnglish", fontName="TimesEmbedded", fontSize=7.45, leading=10.4,
            alignment=TA_LEFT, textColor=INK, firstLineIndent=0,
            leftIndent=6, rightIndent=6, spaceAfter=4,
        ),
        "bullet": ParagraphStyle(
            "Bullet", fontName="NotoSansSC", fontSize=7.1, leading=10.2,
            alignment=TA_LEFT, textColor=INK,
        ),
        "caption": ParagraphStyle(
            "Caption", fontName="NotoSansSC", fontSize=6.35, leading=8.4,
            alignment=TA_LEFT, textColor=MUTED, spaceBefore=3, spaceAfter=7,
        ),
        "equation": ParagraphStyle(
            "Equation", fontName="TimesEmbedded-Italic", fontSize=8.2, leading=11,
            alignment=TA_CENTER, textColor=INK,
        ),
        "reference": ParagraphStyle(
            "Reference", fontName="TimesEmbedded", fontSize=6.45, leading=8.7,
            alignment=TA_LEFT, textColor=INK, leftIndent=12, firstLineIndent=-12,
            spaceAfter=2.5, splitLongWords=True,
        ),
        "table": ParagraphStyle(
            "TableCell", fontName="NotoSansSC", fontSize=5.8, leading=7.4,
            alignment=TA_LEFT, textColor=INK, splitLongWords=True,
        ),
        "table_head": ParagraphStyle(
            "TableHead", fontName="SimHei", fontSize=5.9, leading=7.6,
            alignment=TA_CENTER, textColor=INK,
        ),
        "algorithm": ParagraphStyle(
            "Algorithm", fontName="ConsolasEmbedded", fontSize=5.7, leading=7.4,
            alignment=TA_LEFT, textColor=INK,
        ),
        "cover_note": ParagraphStyle(
            "CoverNote", fontName="NotoSansSC", fontSize=7.6, leading=11.5,
            alignment=TA_LEFT, textColor=INK,
        ),
    }


def safe_text(text: str) -> str:
    return html.escape(text, quote=False).replace("\n", "<br/>")


def make_table(key: str, style_map: dict[str, ParagraphStyle]) -> Table:
    header, rows, widths = TABLES[key]
    data = [[Paragraph(safe_text(cell), style_map["table_head"]) for cell in header]]
    for row in rows:
        data.append([Paragraph(safe_text(str(cell)), style_map["table"]) for cell in row])
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="CENTER")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EAED")),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("GRID", (0, 0), (-1, -1), 0.35, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFAFA")]),
    ]))
    return table


def make_algorithm(key: str, style_map: dict[str, ParagraphStyle]) -> Table:
    rows = [[Paragraph(safe_text(line), style_map["algorithm"])] for line in ALGORITHMS[key]]
    table = Table(rows, colWidths=[238], hAlign="CENTER")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EAED")),
        ("BACKGROUND", (0, 1), (-1, -1), PANEL),
        ("BOX", (0, 0), (-1, -1), 0.7, INK),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, INK),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return table


def make_figure(key: str, style_map: dict[str, ParagraphStyle]) -> KeepTogether:
    factory, caption = FIGURES[key]
    return KeepTogether([
        Spacer(1, 4),
        factory(),
        Paragraph(safe_text(caption), style_map["caption"]),
    ])


def export_figures() -> None:
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    for key, (factory, _) in FIGURES.items():
        renderSVG.drawToFile(factory(), str(FIGURE_DIR / f"{key}.svg"))


def header_footer(canvas, doc) -> None:
    canvas.saveState()
    page = canvas.getPageNumber()
    if page > 1:
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.45)
        canvas.line(16 * mm, A4[1] - 13 * mm, A4[0] - 16 * mm, A4[1] - 13 * mm)
        canvas.setFont("TimesEmbedded", 6.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(16 * mm, A4[1] - 10.5 * mm, "FASTCONTEXT TECHNICAL PREPRINT")
        canvas.drawRightString(A4[0] - 16 * mm, A4[1] - 10.5 * mm, "TurboFlux Research")
        canvas.setFont("TimesEmbedded", 7)
        canvas.drawCentredString(A4[0] / 2, 9 * mm, str(page))
    canvas.restoreState()


def build_story(source: str, style_map: dict[str, ParagraphStyle]) -> list:
    lines = source.splitlines()
    title = lines[0].removeprefix("# ").strip()
    english = lines[2].strip()
    author = lines[4].strip()
    version = lines[6].strip()

    story: list = [
        Spacer(1, 26 * mm),
        Paragraph(safe_text(title), style_map["title"]),
        Paragraph(safe_text(english), style_map["en_title"]),
        Spacer(1, 5 * mm),
        Paragraph(safe_text(author), style_map["author"]),
        Paragraph(safe_text(version), style_map["meta"]),
        Paragraph("System snapshot: <font name='ConsolasEmbedded'>f7b190a77d7cb0362b30b680618d2c6088bdb09f</font>", style_map["meta"]),
        Spacer(1, 11 * mm),
        cover_figure(),
        Spacer(1, 5 * mm),
    ]
    note_data = [[Paragraph(
        "研究定位：本稿是可审计的系统技术预印本。历史基准来自旧架构，只作为先导观察；正式期刊投稿仍需作者信息、目标模板、当前版本多轮实验、统计检验与外部复现。",
        style_map["cover_note"],
    )]]
    note = Table(note_data, colWidths=[154 * mm])
    note.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PANEL),
        ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.extend([note, NextPageTemplate("TwoCol"), PageBreak()])

    body_lines = lines[7:]
    paragraph: list[str] = []
    bullets: list[str] = []
    abstract_mode: str | None = None

    def flush_paragraph() -> None:
        nonlocal paragraph
        if not paragraph:
            return
        text = " ".join(item.strip() for item in paragraph).strip()
        if text:
            if re.match(r"^\[\d+\]", text):
                chosen = style_map["reference"]
            else:
                chosen = style_map["abstract_en"] if abstract_mode == "en" else style_map["abstract"] if abstract_mode == "zh" else style_map["body"]
            story.append(Paragraph(safe_text(text), chosen))
        paragraph = []

    def flush_bullets() -> None:
        nonlocal bullets
        if not bullets:
            return
        items = [ListItem(Paragraph(safe_text(item), style_map["bullet"]), leftIndent=8) for item in bullets]
        story.append(ListFlowable(items, bulletType="bullet", start="circle", leftIndent=14, bulletFontName="ArialEmbedded", bulletFontSize=5))
        story.append(Spacer(1, 3))
        bullets = []

    for raw in body_lines:
        line = raw.strip()
        if not line:
            flush_paragraph()
            flush_bullets()
            continue
        if line.startswith("{{") and line.endswith("}}"):
            flush_paragraph()
            flush_bullets()
            directive = line[2:-2]
            kind, value = directive.split(":", 1)
            if kind == "FIGURE":
                story.append(make_figure(value, style_map))
            elif kind == "TABLE":
                story.append(KeepTogether([Spacer(1, 3), make_table(value, style_map), Spacer(1, 6)]))
            elif kind == "EQUATION":
                eq = Table([[Paragraph(safe_text(value), style_map["equation"])]], colWidths=[238])
                eq.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, -1), PANEL),
                    ("BOX", (0, 0), (-1, -1), 0.4, RULE),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]))
                story.extend([Spacer(1, 2), eq, Spacer(1, 5)])
            elif kind == "ALGORITHM":
                story.extend([Spacer(1, 3), make_algorithm(value, style_map), Spacer(1, 6)])
            elif kind == "FRAMEBREAK":
                story.append(FrameBreak())
            continue
        if line.startswith("## "):
            flush_paragraph()
            flush_bullets()
            heading = line[3:]
            abstract_mode = "zh" if heading == "摘要" else "en" if heading == "Abstract" else None
            story.append(Paragraph(safe_text(heading), style_map["h2"]))
            continue
        if line.startswith("### "):
            flush_paragraph()
            flush_bullets()
            abstract_mode = None
            story.append(Paragraph(safe_text(line[4:]), style_map["h3"]))
            continue
        if line.startswith("- "):
            flush_paragraph()
            bullets.append(line[2:])
            continue
        paragraph.append(line)

    flush_paragraph()
    flush_bullets()
    return story


def build_pdf() -> None:
    register_fonts()
    export_figures()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    page_w, page_h = A4
    margin_x = 16 * mm
    bottom = 15 * mm
    top = 17 * mm
    gutter = 5 * mm
    usable_w = page_w - margin_x * 2
    col_w = (usable_w - gutter) / 2
    usable_h = page_h - top - bottom

    cover_frame = Frame(margin_x, bottom, usable_w, usable_h, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    left_frame = Frame(margin_x, bottom, col_w, usable_h, id="left", leftPadding=0, rightPadding=2, topPadding=0, bottomPadding=0)
    right_frame = Frame(margin_x + col_w + gutter, bottom, col_w, usable_h, id="right", leftPadding=2, rightPadding=0, topPadding=0, bottomPadding=0)

    doc = BaseDocTemplate(
        str(OUTPUT_PDF),
        pagesize=A4,
        leftMargin=margin_x,
        rightMargin=margin_x,
        topMargin=top,
        bottomMargin=bottom,
        title="FastContext: Model-Directed Asynchronous Code Retrieval Architecture",
        author="Critical Leap TurboFlux Research Team",
        subject="Technical preprint on FastContext architecture and evidence-grounded code retrieval",
        creator="TurboFlux reproducible paper generator",
    )
    doc.addPageTemplates([
        PageTemplate(id="Cover", frames=[cover_frame], onPage=header_footer),
        PageTemplate(id="TwoCol", frames=[left_frame, right_frame], onPage=header_footer),
    ])
    source = SOURCE.read_text(encoding="utf-8")
    doc.build(build_story(source, styles()))

    manifest = {
        "title": "FastContext: A Model-Directed Asynchronous Code Retrieval Architecture for Interactive Software Engineering Agents",
        "language": "zh-CN with English abstract",
        "systemCommit": "f7b190a77d7cb0362b30b680618d2c6088bdb09f",
        "historicalBenchmarkCommit": "629e4c25bc646c98113cddca4c86622a286cffdc",
        "historicalBenchmarkStatus": "single-round pilot; not representative of current no-prefetch implementation",
        "generatedPdf": str(OUTPUT_PDF.relative_to(ROOT)).replace("\\", "/"),
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "figures": [str((FIGURE_DIR / f"{key}.svg").relative_to(ROOT)).replace("\\", "/") for key in FIGURES],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    build_pdf()
    print(OUTPUT_PDF)
