import { icon, approvalPolicyIcon } from './workbenchIcons'

export function workbenchShellMarkup(INSPECTOR_UTILITY_NAVIGATION: ReadonlyArray<{ tab: string; label: string; iconName: string }>): string {
  return `
    <div class="background-media-layer" aria-hidden="true">
      <img class="background-media-visual background-media-image" alt="" hidden>
      <video class="background-media-visual background-media-video" autoplay loop muted playsinline hidden></video>
      <div class="background-media-veil"></div>
    </div>
    <div class="desktop-shell">
      <div class="window-sidebar-control">
        <button class="icon-button window-sidebar-toggle" id="sidebar-toggle" type="button" title="折叠侧栏" aria-label="折叠侧栏" aria-pressed="false">${icon('sidebarCollapse')}</button>
      </div>
      <aside class="sidebar">
        <div class="sidebar-titlebar-drag-region" aria-hidden="true"></div>
        <button class="new-task" id="new-task">${icon('newConversation')}<span>新建任务</span></button>

        <nav class="sidebar-nav" aria-label="工作区导航">
          <button class="sidebar-nav-item automation-entry" data-view="automations">${icon('parallel')}<span>自动化</span></button>
          <button class="sidebar-nav-item work-packs-entry" data-view="skills">${icon('pluginNav')}<span>插件</span></button>
        </nav>

        <div class="sidebar-section sidebar-history">
          <div class="workspace-task-header">
            <span>工作区</span>
            <span class="workspace-task-actions">
              <button class="tiny-button" id="workspace-task-add" title="添加工作区" aria-label="添加工作区">${icon('plus')}</button>
            </span>
          </div>
          <div id="conversation-list"></div>
        </div>

        <div class="sidebar-footer">
          <button class="sidebar-profile-identity" id="profile-center-button" type="button" title="用户资料" aria-label="打开用户资料" aria-haspopup="dialog" aria-expanded="false">
            <span class="sidebar-profile-avatar" id="sidebar-profile-avatar" aria-hidden="true">资</span>
            <span class="sidebar-profile-copy"><strong id="sidebar-profile-name">用户资料</strong><small id="sidebar-profile-state">正在读取…</small></span>
            <span class="sidebar-profile-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m10 7 5 5-5 5"/></svg></span>
          </button>
          <div class="sidebar-utilities">
            <button class="sidebar-nav-item sidebar-settings" id="settings-button" title="设置">${icon('settings')}<span>设置</span></button>
          </div>
        </div>
      </aside>

      <div class="workbench-surface">
        <main class="main-panel" id="main-panel">
        <header class="topbar">
          <div class="breadcrumb" id="breadcrumb"><strong id="breadcrumb-title">工作台</strong></div>
        </header>

        <section class="work-plan-dock" id="work-plan-dock" aria-live="polite" hidden></section>

        <div class="main-scroll" id="main-scroll">
          <section class="recovery-banner" id="recovery-banner"></section>
          <section class="welcome-block" id="welcome-block">
            <button class="welcome-profile-avatar" id="welcome-profile-avatar" type="button" aria-label="打开用户资料" aria-haspopup="dialog" aria-expanded="false">你</button>
            <h1 class="workbench-prompt-title" id="welcome-greeting">你好！</h1>
            <p class="welcome-workspace-prompt" id="welcome-workspace-prompt">今天想做点什么呢？</p>
          </section>
          <nav class="conversation-navigator" id="conversation-navigator" aria-label="对话导航" aria-hidden="true">
            <div class="conversation-navigator-markers" id="conversation-navigator-markers"></div>
            <div class="conversation-navigator-popover" id="conversation-navigator-popover" aria-hidden="true">
              <strong id="conversation-navigator-popover-title"></strong>
              <small id="conversation-navigator-popover-summary"></small>
            </div>
          </nav>
          <section class="transcript" id="transcript" aria-live="polite"></section>

          <div class="composer-stack">
            <section class="composer-card" id="composer-card">
              <div class="draft-tray" id="draft-tray"></div>
              <div class="composer-capability-tray" id="composer-capability-tray"></div>
              <textarea id="task-input" placeholder="交代一项工作，或粘贴需要处理的内容" rows="1"></textarea>
              <div class="composer-bottom">
                <div class="composer-tools">
                  <span class="composer-tooltip-anchor"><button class="composer-add-button" id="composer-add" aria-label="添加文件或选择技能" aria-describedby="composer-add-tooltip" aria-haspopup="menu" aria-expanded="false">${icon('plus')}</button><span class="composer-tooltip" id="composer-add-tooltip" role="tooltip">添加文件或选择技能</span></span>
                  <span class="composer-tooltip-anchor"><button class="approval-pill" id="approval-pill" aria-label="更换审批模式" aria-describedby="approval-tooltip" aria-keyshortcuts="Shift+Tab" aria-haspopup="menu" aria-expanded="false"><span class="approval-policy-icon" id="approval-icon" aria-hidden="true">${approvalPolicyIcon('ask')}</span><span id="approval-name">审批策略</span>${icon('chevronDown')}</button><span class="composer-tooltip" id="approval-tooltip" role="tooltip"><span>更换审批模式</span><kbd>⇧ Tab</kbd></span></span>
                </div>
                <div class="composer-submit"><button class="composer-context" id="composer-context" type="button" aria-label="查看上下文使用情况"><span class="composer-context-ring" aria-hidden="true"></span></button><button class="composer-slant-tab reasoning-tab" id="reasoning-tab" title="选择推理强度" aria-haspopup="menu" aria-expanded="false"><span>推理</span><strong id="reasoning-name">加载中</strong>${icon('chevronDown')}</button><button class="model-pill" id="model-pill" aria-haspopup="menu" aria-expanded="false"><span class="model-pill-icon" id="model-icon" aria-hidden="true"></span><span id="model-name">加载中</span>${icon('chevronDown')}</button><button class="run-button" id="run-button" type="button" data-action="send" title="输入内容后发送" aria-label="输入内容后发送" disabled>${icon('sendUp')}</button></div>
              </div>
            </section>
            <div class="composer-start-context" id="composer-start-context" aria-hidden="false">
              <span class="composer-start-runtime">${icon('computer')}<span>本机执行</span></span>
              <button class="composer-start-workspace" id="composer-start-workspace" title="选择工作区">${icon('folder')}<span id="composer-start-workspace-name">选择工作区</span><small id="composer-start-workspace-action">选择</small>${icon('chevronDown')}</button>
            </div>
            <div class="composer-menu" id="composer-menu" aria-hidden="true"></div>
            <div class="capability-menu" id="capability-menu" aria-hidden="true"></div>
            <div class="approval-menu" id="approval-menu" aria-hidden="true"></div>
          </div>

        </div>

        <section class="product-view" id="product-view" aria-hidden="true"></section>

        <section class="terminal-panel" id="terminal-panel" aria-label="终端" aria-hidden="true"></section>

        </main>

        <div class="workbench-window-actions">
          <button class="icon-button terminal-toggle" id="terminal-toggle" title="打开终端" aria-label="打开终端" aria-controls="terminal-panel" aria-pressed="false">${icon('terminal')}</button>
          <button class="icon-button work-plan-toggle" id="work-plan-toggle" type="button" title="收起任务列表" aria-label="收起任务列表" aria-controls="work-plan-dock" aria-pressed="true" hidden>${icon('list')}</button>
          <button class="icon-button work-drawer-toggle" id="inspector-toggle" title="打开工作抽屉" aria-label="打开工作抽屉" aria-pressed="false">${icon('panel')}</button>
        </div>
        <button class="inspector-scrim" id="inspector-scrim" aria-label="关闭侧栏"></button>
        <aside class="inspector" id="inspector-panel" aria-hidden="true">
          <span class="inspector-edge-shadow" aria-hidden="true"></span>
          <div class="inspector-resize-handle" id="inspector-resize-handle" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整右侧面板宽度" aria-describedby="inspector-resize-help" aria-keyshortcuts="ArrowLeft ArrowRight Home End" title="拖动调整宽度；方向键可微调，Home 收窄，End 全屏，双击恢复默认宽度"></div>
          <span class="visually-hidden" id="inspector-resize-help">拖动调整宽度；越过左侧会话区中点进入全屏，从左边缘向右拖回可恢复。方向键每次调整 10 像素，Home 收窄，End 全屏，双击恢复默认宽度。</span>
          <div class="inspector-viewport">
            <div class="inspector-frame">
              <div class="inspector-header">
                <nav class="inspector-nav" aria-label="工作抽屉">
                  <div class="inspector-tabs" id="inspector-tabs" role="tablist"></div>
                  <span class="browser-activity-pill compact inspector-browser-activity" id="inspector-browser-activity" hidden>${icon('spark')}<span>浏览器运行中</span></span>
                  <button class="inspector-header-action" id="inspector-module-menu-toggle" type="button" title="添加标签页" aria-label="添加标签页" aria-haspopup="menu" aria-expanded="false">${icon('plus')}</button>
                  <button class="inspector-header-action" id="inspector-expand" type="button" title="展开面板" aria-label="展开面板" aria-pressed="false">${icon('expand')}</button>
                </nav>
                <div class="inspector-module-menu" id="inspector-module-menu" role="menu" aria-hidden="true"><button class="inspector-module-option" id="inspector-browser-new-tab" type="button" role="menuitem">${icon('browser')}<span>新建浏览器标签页</span></button>${INSPECTOR_UTILITY_NAVIGATION.map(item => `<button class="inspector-module-option" type="button" role="menuitemradio" aria-checked="false" data-tab="${item.tab}">${icon(item.iconName)}<span>${item.label}</span><span class="inspector-module-check" aria-hidden="true">${icon('check')}</span></button>`).join('')}</div>
              </div>
              <div class="inspector-content" id="inspector-content"></div>
              <span class="visually-hidden" id="runtime-policy">正在准备</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div class="toast" id="toast" role="status"></div>
  `

}
