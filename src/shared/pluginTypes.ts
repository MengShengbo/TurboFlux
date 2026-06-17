/**
 * Turboflux 插件系统类型定义
 * 
 * 插件架构设计原则：
 * 1. 安全第一 - 插件运行在受限环境中
 * 2. 声明式 - 通过 manifest 声明能力，而非代码
 * 3. 热插拔 - 支持动态安装/卸载/启用/禁用
 * 4. 版本兼容 - 明确的版本约束和兼容性检查
 */

// ==================== 基础类型 ====================

export type PluginID = string;
export type PluginVersion = string;
export type SemVer = `${number}.${number}.${number}`;

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

// ==================== 插件清单 ====================

export interface PluginManifest {
  /** 插件唯一标识符 (格式: @scope/name 或 name) */
  id: PluginID;
  
  /** 显示名称 */
  name: string;
  
  /** 插件描述 */
  description: string;
  
  /** 版本号 (遵循 SemVer) */
  version: PluginVersion;
  
  /** 作者信息 */
  author: PluginAuthor;
  
  /** 许可证 */
  license?: string;
  
  /** 插件图标 (本地路径或 URL) */
  icon?: string;
  
  /** 主页 URL */
  homepage?: string;
  
  /** 仓库 URL */
  repository?: string;
  
  /** Minimum host application version this plugin supports.
   *  The legacy field name `turboforge` is preserved on disk so existing
   *  plugin manifests (.json) keep validating; do not rename it without
   *  also bumping the plugin manifest schema version and writing a migrator.
   *  New manifests should use `turboflux` instead. */
  engines?: {
    turboforge: string;
    turboflux?: string;
  };
  
  /** 插件分类 */
  categories?: PluginCategory[];
  
  /** 关键词标签 */
  keywords?: string[];
  
  /** 激活事件 - 何时加载插件 */
  activationEvents?: ActivationEvent[];
  
  /** 贡献点 - 插件提供的功能 */
  contributes?: PluginContributes;
  
  /** 权限声明 */
  permissions?: PluginPermission[];
  
  /** 依赖的其他插件 */
  dependencies?: Record<PluginID, string>;
  
  /** 主入口文件 (相对路径) */
  main?: string;
}

export type PluginCategory =
  | 'ai-model'      // AI 模型提供商
  | 'theme'         // 主题
  | 'language'      // 语言支持
  | 'tool'          // 工具
  | 'integration'   // 第三方集成
  | 'productivity'  // 生产力
  | 'custom';       // 自定义

export type ActivationEvent =
  | '*'                    // 启动时立即激活
  | 'onStartupFinished'    // 启动完成后
  | 'onCommand:<id>'       // 特定命令被调用
  | 'onView:<id>'          // 特定视图被打开
  | 'onFile:<glob>'        // 匹配文件被打开
  | 'onLanguage:<lang>'    // 特定语言文件被打开
  | 'onMode:<mode>'        // 特定模式被激活
  | 'onTask:<type>';       // 特定类型任务被创建

// ==================== 贡献点 ====================

export interface PluginContributes {
  /** 命令 */
  commands?: PluginCommand[];
  
  /** 配置项 */
  configuration?: PluginConfiguration[];
  
  /** 菜单项 */
  menus?: PluginMenus;
  
  /** 快捷键 */
  keybindings?: PluginKeybinding[];
  
  /** 主题 */
  themes?: PluginTheme[];
  
  /** AI 工具 */
  tools?: PluginTool[];
  
  /** 代理 */
  agents?: PluginAgent[];
  
  /** Skills - AI 技能 */
  skills?: PluginSkill[];
  
  /** 钩子 */
  hooks?: PluginHooks;
  
  /** 视图 */
  views?: PluginView[];
  
  /** 侧边栏面板 */
  viewsContainers?: PluginViewsContainer[];
}

// 命令
export interface PluginCommand {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  when?: string; // 条件表达式
}

// 配置项
export interface PluginConfiguration {
  id: string;
  title: string;
  properties: Record<string, ConfigProperty>;
}

export interface ConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  default?: unknown;
  description?: string;
  enum?: unknown[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

// 菜单
export interface PluginMenus {
  'commandPalette'?: MenuItem[];
  'editor/context'?: MenuItem[];
  'explorer/context'?: MenuItem[];
  'sidebar/activity'?: MenuItem[];
  'statusBar'?: MenuItem[];
}

export interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

// 快捷键
export interface PluginKeybinding {
  command: string;
  key: string;
  when?: string;
  mac?: string;
  linux?: string;
  win?: string;
}

// 主题
export interface PluginTheme {
  id: string;
  label: string;
  uiTheme: 'vs' | 'vs-dark' | 'hc-black';
  path: string;
}

// AI 工具
export interface PluginTool {
  id: string;
  name: string;
  description: string;
  icon?: string;
  parameters?: ToolParameter[];
  handler: string; // 处理函数名
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
}

// 代理
export interface PluginAgent {
  id: string;
  name: string;
  description: string;
  icon?: string;
  systemPrompt?: string;
  tools?: string[]; // 工具 ID 列表
  model?: string;
}

// Skill - AI 技能
export interface PluginSkill {
  /** Skill ID */
  id: string;
  
  /** 显示名称 */
  name: string;
  
  /** 触发命令 (如 /plan) */
  command: string;
  
  /** 描述 */
  description: string;
  
  /** 图标 */
  icon?: string;
  
  /** 分类 */
  category: SkillCategory;
  
  /** 系统提示词文件路径或内联内容 */
  systemPrompt?: string;
  
  /** 系统提示词文件路径 */
  promptPath?: string;
  
  /** 能力范围 */
  capabilities?: {
    can: string[];
    cannot: string[];
  };
  
  /** 核心原则 */
  principles?: string[];
  
  /** 工具定义 */
  tools?: SkillTool[];
  
  /** 输出格式 */
  outputFormat?: string;
  
  /** 示例 */
  examples?: SkillExample[];
  
  /** 自动触发条件 */
  autoTrigger?: {
    onFile?: string;
    onMode?: string;
    onTask?: string;
  };
}

export type SkillCategory =
  | 'core'          // 核心功能
  | 'design'        // 设计类
  | 'code-quality'  // 代码质量
  | 'engineering'   // 工程类
  | 'ai-ml'         // AI/机器学习
  | 'devops'        // DevOps
  | 'security'      // 安全
  | 'custom';       // 自定义

export interface SkillTool {
  name: string;
  description: string;
  parameters?: ToolParameter[];
}

export interface SkillExample {
  input: string;
  output?: string;
  description?: string;
}

// 钩子
export interface PluginHooks {
  preTask?: string;
  postTask?: string;
  preToolUse?: string;
  postToolUse?: string;
  onModeChange?: string;
  onFileChange?: string;
}

// 视图
export interface PluginView {
  id: string;
  name: string;
  when?: string;
  icon?: string;
}

// 视图容器
export interface PluginViewsContainer {
  id: string;
  title: string;
  icon: string;
}

// ==================== 权限 ====================

export type PluginPermission =
  | 'filesystem.read'      // 读取文件系统
  | 'filesystem.write'     // 写入文件系统
  | 'network'              // 网络访问
  | 'terminal'             // 终端访问
  | 'clipboard'            // 剪贴板访问
  | 'notifications'        // 发送通知
  | 'webview'              // 创建 WebView
  | 'ai'                   // AI 服务访问
  | 'storage'              // 存储访问
  | 'process'              // 进程管理
  | 'unsafe-eval';         // 允许 eval (危险)

// ==================== 插件状态 ====================

export type PluginState = 
  | 'installing'   // 安装中
  | 'installed'    // 已安装
  | 'enabling'     // 启用中
  | 'enabled'      // 已启用
  | 'disabling'    // 禁用中
  | 'disabled'     // 已禁用
  | 'uninstalling' // 卸载中
  | 'error';       // 错误状态

export interface LoadedPlugin {
  id: PluginID;
  manifest: PluginManifest;
  
  /** 安装路径 */
  path: string;
  
  /** 来源 (marketplace/local/git) */
  source: string;
  
  /** 当前状态 */
  state: PluginState;
  
  /** 是否启用 */
  enabled: boolean;
  
  /** 安装时间 */
  installedAt: string;
  
  /** 最后更新时间 */
  updatedAt: string;
  
  /** 错误信息 */
  error?: string;
  
  /** 是否内置插件 */
  isBuiltin?: boolean;
  
  /** 是否开发模式 */
  isDevelopment?: boolean;
}

// ==================== 插件市场 ====================

export interface PluginMarketplace {
  id: string;
  name: string;
  description?: string;
  url: string;
  icon?: string;
  trusted?: boolean;
  autoUpdate?: boolean;
}

export interface MarketplacePlugin {
  id: PluginID;
  manifest: PluginManifest;
  downloadUrl: string;
  readme?: string;
  changelog?: string;
  downloadCount: number;
  rating: number;
  reviewCount: number;
  lastUpdated: string;
}

// ==================== 插件消息 ====================

export interface PluginMessage {
  type: string;
  payload?: unknown;
}

export interface PluginAPI {
  // 存储
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
  };
  
  // 文件系统
  filesystem: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    readDirectory(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    delete(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
  };
  
  // 窗口
  window: {
    showInformationMessage(message: string): Promise<void>;
    showWarningMessage(message: string): Promise<void>;
    showErrorMessage(message: string): Promise<void>;
    showInputBox(options: { prompt?: string; placeholder?: string; value?: string }): Promise<string | undefined>;
    showQuickPick(items: string[], options?: { placeholder?: string }): Promise<string | undefined>;
  };
  
  // AI
  ai: {
    invokeTool(toolId: string, params: unknown): Promise<unknown>;
    createAgent(config: Partial<PluginAgent>): Promise<string>;
    invokeSkill(skillId: string, params?: unknown): Promise<unknown>;
    getAvailableModels(): Promise<string[]>;
  };
  
  // 任务
  tasks: {
    createTask(type: string, data: unknown): Promise<string>;
    onDidCreateTask(callback: (task: unknown) => void): () => void;
    updateTask(taskId: string, updates: unknown): Promise<void>;
    completeTask(taskId: string): Promise<void>;
  };
  
  // 事件
  events: {
    on(event: string, callback: (data: unknown) => void): () => void;
    emit(event: string, data?: unknown): void;
    once(event: string, callback: (data: unknown) => void): () => void;
  };
  
  // 命令
  commands: {
    registerCommand(id: string, handler: (...args: unknown[]) => unknown): void;
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
    getCommands(): string[];
  };
  
  // 工具
  tools: {
    registerTool(tool: PluginTool, handler: (params: unknown) => Promise<unknown>): void;
    invokeTool(toolId: string, params: unknown): Promise<unknown>;
    getTools(): PluginTool[];
  };
  
  // Skills
  skills: {
    registerSkill(skill: PluginSkill): void;
    invokeSkill(skillId: string, context?: unknown): Promise<unknown>;
    getSkills(): PluginSkill[];
    getSkillByCommand(command: string): PluginSkill | undefined;
  };
  
  // Vendor - 原生功能
  vendor: {
    // 图片处理
    imageProcessor: {
      isAvailable(): boolean;
      sharp(input: Buffer): SharpInstance;
      readClipboardImage?(maxWidth?: number, maxHeight?: number): Promise<ClipboardImageResult | null>;
      hasClipboardImage?(): boolean;
    };
    
    // 音频录制/播放
    audioCapture: {
      isAvailable(): boolean;
      startRecording(onData: (data: Buffer) => void, onEnd: () => void): boolean;
      stopRecording(): void;
      isRecording(): boolean;
      startPlayback(sampleRate: number, channels: number): boolean;
      writePlaybackData(data: Buffer): void;
      stopPlayback(): void;
      isPlaying(): boolean;
      microphoneAuthorizationStatus(): number;
    };
    
    // URL Scheme 处理
    urlHandler: {
      isAvailable(): boolean;
      registerUrlHandler(): Promise<boolean>;
      getLaunchUrl(): string | null;
      onOpenUrl(callback: (url: string) => void): () => void;
    };
    
    // 键盘修饰键检测 (macOS only)
    modifiers: {
      isAvailable(): boolean;
      getModifiers(): string[];
      isModifierPressed(modifier: string): boolean;
    };
  };
}

// Sharp 实例接口
export interface SharpInstance {
  metadata(): Promise<{ width: number; height: number; format: string }>;
  resize(width: number, height: number, options?: { fit?: string; withoutEnlargement?: boolean }): SharpInstance;
  jpeg(options?: { quality?: number }): SharpInstance;
  png(options?: { compressionLevel?: number; palette?: boolean; colors?: number }): SharpInstance;
  webp(options?: { quality?: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

// 剪贴板图片结果
export interface ClipboardImageResult {
  png: Buffer;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

// ==================== 插件上下文 ====================

export interface PluginContext {
  id: PluginID;
  manifest: PluginManifest;
  path: string;
  api: PluginAPI;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
}

// 插件入口导出的接口
export interface PluginModule {
  activate?(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
