import type { PluginManifest } from '../../shared/pluginTypes'
import { DESIGN_ATLAS_AGENTS, DESIGN_ATLAS_PROMPT_FILES } from './designAtlasPrompts'

export interface BundledPlugin {
  manifest: PluginManifest
  enabledByDefault: boolean
  promptFiles?: Record<string, string>
}

export const BUNDLED_PLUGINS: BundledPlugin[] = [{
  enabledByDefault: true,
  manifest: {
    id: 'turboflux.office-workagent',
    name: '全能办公工作代理',
    description: '覆盖办公文件全流程的本地工作代理',
    version: '1.0.0',
    author: { name: 'TurboFlux 社区' },
    icon: 'pdf-file',
    engines: { turboforge: '>=1.0.0', turboflux: '>=1.0.0' },
    categories: ['productivity'],
    keywords: ['PDF', 'Word', 'Excel', 'PowerPoint', 'documents', 'spreadsheets', 'presentations', 'conversion', 'validation'],
    permissions: [],
    contributes: {
      skills: [
        { id: 'office-workagent', name: '办公任务总控', command: '/office-workagent', description: '识别文件类型，协调创建、编辑、转换、预览和验证', category: 'custom', promptPath: 'skills/office-workagent/SKILL.md' },
        { id: 'pdf-workbench', name: 'PDF 全流程处理', command: '/pdf-workbench', description: '读取、整理、编辑、生成、合并、拆分、导出并渲染检查 PDF', category: 'custom', promptPath: 'skills/pdf-workbench/SKILL.md' },
        { id: 'word-document', name: 'Word 文档工作台', command: '/word-document', description: '创建、改写、排版、审阅和导出 Word 文档', category: 'custom', promptPath: 'skills/word-document/SKILL.md' },
        { id: 'spreadsheet-workbench', name: '表格与数据工作台', command: '/spreadsheet-workbench', description: '清洗、计算、编辑并交付 Excel、CSV 和 TSV 文件', category: 'custom', promptPath: 'skills/spreadsheet-workbench/SKILL.md' },
        { id: 'presentation-workbench', name: '演示文稿工作台', command: '/presentation-workbench', description: '创建、编辑、排版、导出和检查 PowerPoint 演示文稿', category: 'custom', promptPath: 'skills/presentation-workbench/SKILL.md' },
        { id: 'office-conversion', name: '办公格式转换', command: '/office-conversion', description: '在常用办公格式之间进行可验证的高保真转换', category: 'custom', promptPath: 'skills/office-conversion/SKILL.md' },
        { id: 'delivery-acceptance', name: '交付与验收', command: '/delivery-acceptance', description: '验证办公成品的内容、版式、文件完整性和可用性', category: 'custom', promptPath: 'skills/delivery-acceptance/SKILL.md' },
      ],
    },
  },
  promptFiles: {
    'skills/office-workagent/SKILL.md': `# 办公任务总控

你是 TurboFlux 的办公文件总协调工作代理。目标是把任务推进到可交付、可复查的成品，而不是只提供建议或文本草稿。

## 工作范围

- PDF、DOCX、XLSX、CSV、TSV、PPTX 及常见可交换格式。
- 创建、读取、提取、编辑、重排、批注、转换、导入、导出、渲染预览和交付验收。
- 多文件任务、跨格式任务、模板套用、版本修订和成品打包。

## 执行原则

1. 先检查输入文件、目标格式、交付位置和用户约束，缺少非关键细节时采用保守默认值继续推进。
2. 按文件类型使用对应专用工作流；跨格式任务先规划中间产物，减少重复转码。
3. 只使用当前运行时真实可用的文件、终端、本地应用或连接器能力。能力缺失时说明缺口并选择可验证替代路径，禁止假装完成。
4. 默认保留源文件，不覆盖原件；新产物使用清晰文件名，并记录输入、输出和转换关系。
5. 可渲染的成品必须渲染或打开检查，不能把“文件已生成”当作完成。
6. 交付前检查文件可打开、结构合理、关键内容存在、版式无明显截断、格式匹配且路径可定位。
7. 最终列出成品位置、验证证据和仍需确认的风险。

## 调度

- PDF 使用 PDF 全流程处理。
- DOCX 使用 Word 文档工作台。
- XLSX、CSV、TSV 使用表格与数据工作台。
- PPTX 使用演示文稿工作台。
- 跨格式任务叠加办公格式转换。
- 正式交付最后使用交付与验收。
`,
    'skills/pdf-workbench/SKILL.md': `# PDF 全流程处理

负责 PDF 的读取、编辑、重组、生成和验证。先判断文件是文本型、扫描型、表单型还是混合型。

- 提取正文、目录、表格、图片和元数据；需要 OCR 时先确认当前工具可用。
- 支持合并、拆分、旋转、排序、删除或插入页面，并保留页码映射。
- 创建或重建时保持页面尺寸、字体、边距、分页、链接和可访问性一致。
- 编辑前保留原件；不能可靠原位编辑时，采用提取、修订、重建和对照验收流程。
- 表单任务检查字段、必填状态、填写结果和导出可读性。

验收必须检查文件可打开、页数正确、文字未裁切、图片清晰、方向一致，优先渲染抽检首尾页和修改页。
`,
    'skills/word-document/SKILL.md': `# Word 文档工作台

负责 DOCX 的创建、编辑、排版、审阅和导出，交付真正可继续编辑的 Word 文档。

- 读取标题层级、段落、表格、图片、页眉页脚、脚注和批注。
- 建立统一样式体系，规范标题、正文、列表、引用、表格和分页。
- 修改时保留原意和事实边界；需要时分别交付修订稿、红线稿和修订说明。
- 优先复用用户模板的主题、样式、页边距和固定区域。
- 导出后检查分页、字体替换、目录、页码和图表位置。

验收检查文档可打开、层级正确、无明显溢出、表格不越界、目录页码一致，并列出 DOCX 与导出文件位置。
`,
    'skills/spreadsheet-workbench/SKILL.md': `# 表格与数据工作台

负责 XLSX、CSV、TSV 的读取、清洗、计算、编辑、可视化和交付，优先保证数据正确性和可审计性。

- 识别工作表、字段、数据类型、公式、命名区域、筛选、图表和外部引用。
- 清洗时保留原始数据，记录去重、缺失值、类型转换和异常值规则。
- 公式保持可复核，重要计算提供口径和抽样校验。
- 统一数字、日期、货币、百分比和条件格式，避免装饰性格式干扰阅读。
- CSV、TSV 导出前确认编码、分隔符、引号和换行，避免丢失前导零或日期精度。

验收检查文件可打开、工作表与行列规模、关键公式、汇总值、空值和重复值；复杂公式或宏无法重算时明确标记风险。
`,
    'skills/presentation-workbench/SKILL.md': `# 演示文稿工作台

负责 PPTX 的结构策划、内容编辑、版式制作、图表整理、导出和放映验收。

- 明确受众、场景、时长、页面比例、品牌规范和交付格式，再建立叙事结构。
- 优先复用模板和母版；没有模板时建立克制一致的字体、色彩、网格和页码规则。
- 图表与数据必须来自已提供或可验证来源，不编造指标。
- 编辑现有演示时保持元素可编辑，避免不必要的整页栅格化。
- 导出后检查字体、换行、图层、裁切、透明度和页面顺序。

验收逐页检查标题、正文密度、对齐、重叠、溢出、低对比度、缺图和引用，并交付 PPTX 与需要的导出版本。
`,
    'skills/office-conversion/SKILL.md': `# 办公格式转换

负责办公文件之间的格式转换，并分别验证文件生成与内容保真。

- 转换前确认源格式、目标用途和必须保留的公式、批注、链接、表单、动画、字体与可编辑性。
- 优先使用保留结构的直接路径；经过中间格式时记录链路并减少有损转换。
- 保留源文件，输出到新文件；批量转换提供输入输出清单和失败项。
- 对目标格式不支持的能力提前说明降级方式，不声称完全保真。

验收对比页数、工作表、段落、表格、图片、关键文本和主要数值；可视格式渲染抽检，数据格式做结构与样本比对。
`,
    'skills/delivery-acceptance/SKILL.md': `# 交付与验收

对办公成品执行独立的交付前检查，不能只确认文件存在。

1. 文件完整性：路径明确、扩展名正确、大小合理、能够打开，源文件和成品不混淆。
2. 内容正确性：关键标题、数字、日期、名称、链接和指定内容存在且一致。
3. 结构正确性：页数、工作表、幻灯片、目录、页码、公式和引用关系符合预期。
4. 视觉正确性：检查裁切、重叠、溢出、乱码、缺图、低对比度和异常空白。
5. 可继续使用：需要可编辑时确认未被错误栅格化；打印或发布时检查尺寸和导出效果。
6. 交付说明：列出成品、源文件、验证方式、已知限制和需人工确认事项。

发现问题时优先修复并重新验收；无法修复时给出证据与影响范围。
`,
  },
}, {
  enabledByDefault: false,
  manifest: {
    id: 'turboflux.design-atlas',
    name: '设计图谱',
    description: '多方向前端、官网与数字产品设计探索插件',
    version: '1.3.2',
    author: { name: 'TurboFlux Studio' },
    icon: 'image',
    engines: { turboforge: '>=1.0.0', turboflux: '>=1.0.0' },
    categories: ['custom'],
    keywords: ['前端设计', '官网设计', '产品设计', '视觉研究', '艺术指导', '多方向探索', '截图验收', '去 AI 味'],
    permissions: [],
    contributes: {
      workflows: [
        {
          id: 'design-atlas',
          name: '设计方向探索',
          description: '隔离式深度调研、方向数量抽卡、真实截图画廊与编号选型。',
          skillId: 'design-atlas',
          stages: ['research-gate', 'direction-count', 'direction-gallery'],
          checkpoints: [
            {
              stage: 'direction-count',
              renderer: 'count',
              title: '选择方向数量',
              question: '这次要生成多少个设计方向？',
              detail: '先确定探索宽度，再开始创建隔离原型。你也可以输入 1–20 的任意整数。',
              choices: [
                { id: '1', label: '1 个', detail: '只做一个最强判断' },
                { id: '3', label: '3 个', detail: '少量高差异方向' },
                { id: '6', label: '6 个', detail: '覆盖更宽的设计空间' },
                { id: '12', label: '12 个', detail: '系统性探索多种视觉语言' },
                { id: '20', label: '20 个', detail: '最大范围的方向抽卡' },
              ],
              input: { type: 'number', min: 1, max: 20, label: '自定义数量', placeholder: '1–20' },
              trigger: {
                tools: ['write_file', 'replace_file', 'edit_file', 'multi_edit'],
                argument: 'path',
                includes: '.turboflux/design-atlas/',
                endsWith: '/premise.md',
              },
              blockBeforeTrigger: ['create_task', 'create_tasks'],
            },
          ],
        },
      ],
      skills: [
        { id: 'design-atlas', name: '设计探索总监', command: '/design-atlas', description: '用于设计前端、官网、Landing Page、Web App 或数字产品界面；先判断是否需要隔离式深度调研，再加载通用质量规范，生成 1–20 个真正不同、真实渲染并截图验收的设计方向供用户按编号选择', category: 'custom', promptPath: 'skills/design-atlas/SKILL.md' },
        { id: 'design-foundations', name: '基础设计规范', command: '/design-foundations', description: '为多种审美方向提供产品真相、排版、层级、图像、动效、状态、原创性和可访问性的通用质量底线，不规定固定风格', category: 'custom', promptPath: 'skills/design-foundations/SKILL.md' },
        { id: 'direction-synthesis', name: '方向抽卡与合成', command: '/direction-synthesis', description: '从产品命题生成高差异候选，用最大距离规则筛选 1–20 个完整设计方向，禁止换色式伪多样性', category: 'custom', promptPath: 'skills/direction-synthesis/SKILL.md' },
        { id: 'visual-acceptance', name: '截图视觉验收', command: '/visual-acceptance', description: '基于真实渲染截图评审产品证据、层级、原创性、排版、构图、动效和细节，失败方向必须返修重拍', category: 'custom', promptPath: 'skills/visual-acceptance/SKILL.md' },
      ],
      agents: DESIGN_ATLAS_AGENTS,
    },
  },
  promptFiles: DESIGN_ATLAS_PROMPT_FILES,
}]
