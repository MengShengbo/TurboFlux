export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TurboFlux Admin</title>
  <style>
    :root {
      --paper: #f5eedf;
      --paper-deep: #e4d4ba;
      --paper-line: rgba(72, 50, 28, 0.18);
      --ink: #2d2419;
      --muted: #75634f;
      --cloth: #47574e;
      --cloth-dark: #2f3b36;
      --accent: #8a4f35;
      --accent-2: #2f6f73;
      --danger: #9b342b;
      --ok: #3d6b42;
      --shadow: 0 22px 60px rgba(45, 36, 25, 0.22);
    }

    * { box-sizing: border-box; }

    html, body { min-height: 100%; }

    body {
      margin: 0;
      color: var(--ink);
      font-family: ui-serif, Georgia, "Times New Roman", "Noto Serif SC", serif;
      background:
        radial-gradient(circle at 12% 8%, rgba(82, 61, 36, 0.12) 0 1px, transparent 1px),
        radial-gradient(circle at 78% 24%, rgba(82, 61, 36, 0.09) 0 1px, transparent 1px),
        linear-gradient(135deg, #dbc8a9, #f6efe2 34%, #e7d8bf 100%);
      background-size: 22px 22px, 34px 34px, 100% 100%;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        repeating-linear-gradient(0deg, rgba(72, 50, 28, 0.025), rgba(72, 50, 28, 0.025) 1px, transparent 1px, transparent 5px),
        linear-gradient(90deg, rgba(255,255,255,0.22), rgba(95, 68, 38, 0.10));
      mix-blend-mode: multiply;
    }

    button, input, textarea {
      font: inherit;
    }

    .book {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: calc(100vh - 36px);
      margin: 18px;
      border: 1px solid rgba(83, 59, 33, 0.28);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
      background: var(--paper);
    }

    .spine {
      display: flex;
      flex-direction: column;
      gap: 28px;
      padding: 30px 24px;
      background:
        linear-gradient(90deg, rgba(34, 45, 39, 0.92), rgba(67, 82, 73, 0.94)),
        repeating-linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.05) 1px, transparent 1px, transparent 8px);
      color: #f8f1e3;
      border-right: 8px solid rgba(72, 50, 28, 0.20);
    }

    .brand {
      display: grid;
      gap: 8px;
      padding-bottom: 22px;
      border-bottom: 1px solid rgba(248, 241, 227, 0.25);
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(248, 241, 227, 0.45);
      border-radius: 6px;
      color: #f8f1e3;
      letter-spacing: 0;
      font-weight: 800;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.05;
      letter-spacing: 0;
    }

    .subtitle {
      margin: 0;
      color: rgba(248, 241, 227, 0.72);
      font-size: 14px;
      line-height: 1.5;
    }

    .nav {
      display: grid;
      gap: 10px;
    }

    .nav-button {
      width: 100%;
      display: grid;
      grid-template-columns: 46px 1fr;
      align-items: center;
      gap: 12px;
      padding: 12px 10px;
      color: rgba(248, 241, 227, 0.78);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      text-align: left;
      cursor: pointer;
    }

    .nav-button:hover,
    .nav-button.active {
      color: #fff9ec;
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(248, 241, 227, 0.20);
    }

    .nav-code {
      display: grid;
      place-items: center;
      min-width: 42px;
      height: 30px;
      border: 1px solid rgba(248, 241, 227, 0.26);
      border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
    }

    .token-box {
      margin-top: auto;
      display: grid;
      gap: 9px;
    }

    .token-box label {
      color: rgba(248, 241, 227, 0.78);
      font-size: 13px;
    }

    .token-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 42px;
      gap: 8px;
    }

    .token-row input {
      min-width: 0;
      color: #fff9ec;
      background: rgba(0, 0, 0, 0.16);
      border: 1px solid rgba(248, 241, 227, 0.24);
      border-radius: 5px;
      padding: 10px;
    }

    .token-row button {
      color: #fff9ec;
      background: rgba(255, 255, 255, 0.10);
      border: 1px solid rgba(248, 241, 227, 0.26);
      border-radius: 5px;
      cursor: pointer;
    }

    .page {
      position: relative;
      min-width: 0;
      padding: 34px;
      background:
        linear-gradient(90deg, rgba(97, 68, 36, 0.11), transparent 22px),
        linear-gradient(#f8f1e3, var(--paper));
    }

    .page::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-left: 1px solid rgba(68, 45, 24, 0.12);
      box-shadow: inset 16px 0 24px rgba(68, 45, 24, 0.08);
    }

    .page-head {
      position: relative;
      z-index: 1;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--paper-line);
    }

    .page-title {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .page-note {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.6;
      max-width: 650px;
    }

    .status-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 5px 10px;
      border: 1px solid var(--paper-line);
      border-radius: 999px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.28);
      font-size: 13px;
      white-space: nowrap;
    }

    .pill.ok { color: var(--ok); border-color: rgba(61, 107, 66, 0.28); }
    .pill.warn { color: var(--danger); border-color: rgba(155, 52, 43, 0.28); }

    .panel {
      position: relative;
      z-index: 1;
      margin-top: 24px;
      padding: 24px;
      border: 1px solid rgba(87, 61, 34, 0.24);
      border-radius: 8px;
      background: rgba(255, 252, 244, 0.56);
    }

    .panel h2 {
      margin: 0 0 18px;
      font-size: 20px;
      letter-spacing: 0;
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field.full { grid-column: 1 / -1; }

    .field label {
      color: var(--muted);
      font-size: 14px;
    }

    .field input,
    .field textarea {
      width: 100%;
      padding: 10px 12px;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.54);
      border: 1px solid rgba(82, 58, 32, 0.28);
      border-radius: 6px;
      outline: none;
    }

    .field input {
      min-height: 42px;
    }

    .field textarea {
      min-height: 190px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
    }

    .field input:focus,
    .field textarea:focus {
      border-color: rgba(47, 111, 115, 0.62);
      box-shadow: 0 0 0 3px rgba(47, 111, 115, 0.12);
    }

    .checks {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      align-items: center;
      color: var(--muted);
      font-size: 14px;
    }

    .checks input { width: auto; min-height: auto; }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 20px;
    }

    .primary,
    .secondary {
      min-height: 40px;
      padding: 9px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
    }

    .primary {
      color: #fff9ec;
      background: var(--accent);
      border-color: rgba(92, 48, 31, 0.35);
    }

    .secondary {
      color: var(--ink);
      background: rgba(255,255,255,0.38);
      border-color: rgba(82, 58, 32, 0.28);
    }

    .message {
      min-height: 24px;
      color: var(--muted);
      font-size: 14px;
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border: 1px solid rgba(82, 58, 32, 0.18);
      border-radius: 6px;
    }

    .table th,
    .table td {
      padding: 13px 12px;
      border-bottom: 1px solid rgba(82, 58, 32, 0.14);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    .table th {
      color: var(--muted);
      background: rgba(105, 78, 45, 0.08);
      font-weight: 700;
    }

    .table tr:last-child td { border-bottom: 0; }

    .mono {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px;
    }

    .empty {
      min-height: 180px;
      display: grid;
      place-items: center;
      color: var(--muted);
      border: 1px dashed rgba(82, 58, 32, 0.28);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.24);
      text-align: center;
      line-height: 1.7;
    }

    .hidden { display: none; }

    @media (max-width: 880px) {
      .book {
        grid-template-columns: 1fr;
        margin: 0;
        min-height: 100vh;
        border-radius: 0;
      }

      .spine {
        gap: 18px;
        padding: 20px;
      }

      .nav {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .nav-button {
        grid-template-columns: 1fr;
        justify-items: center;
        text-align: center;
      }

      .page {
        padding: 22px;
      }

      .page-head {
        display: grid;
      }

      .status-strip {
        justify-content: flex-start;
      }

      .form-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="book">
    <aside class="spine">
      <div class="brand">
        <div class="brand-mark">TF</div>
        <h1>TurboFlux</h1>
        <p class="subtitle">本地后台管理</p>
      </div>

      <nav class="nav" aria-label="后台导航">
        <button class="nav-button active" type="button" data-tab="api">
          <span class="nav-code">API</span><span>API 配置</span>
        </button>
        <button class="nav-button" type="button" data-tab="users">
          <span class="nav-code">USR</span><span>用户管理</span>
        </button>
        <button class="nav-button" type="button" data-tab="logs">
          <span class="nav-code">LOG</span><span>日志</span>
        </button>
      </nav>

      <div class="token-box">
        <label for="adminToken">访问令牌</label>
        <div class="token-row">
          <input id="adminToken" type="password" autocomplete="off" placeholder="X-TurboFlux-Token">
          <button id="saveToken" type="button" title="保存到本机浏览器">OK</button>
        </div>
      </div>
    </aside>

    <section class="page">
      <div class="page-head">
        <div>
          <h2 id="pageTitle" class="page-title">API 配置</h2>
          <p id="pageNote" class="page-note">模型代理、密钥与本地服务状态。</p>
        </div>
        <div id="statusStrip" class="status-strip"></div>
      </div>

      <section id="tab-api" class="tab-panel">
        <div class="panel">
          <h2>上游模型</h2>
          <form id="configForm">
            <div class="form-grid">
              <div class="field full">
                <label for="upstreamBaseUrl">Base URL</label>
                <input id="upstreamBaseUrl" name="upstreamBaseUrl" type="url" required>
              </div>
              <div class="field">
                <label for="defaultModel">默认模型</label>
                <input id="defaultModel" name="defaultModel" required>
              </div>
              <div class="field">
                <label for="corsOrigin">CORS Origin</label>
                <input id="corsOrigin" name="corsOrigin" placeholder="http://127.0.0.1">
              </div>
              <div class="field full">
                <label for="modelsJson">Models JSON</label>
                <textarea id="modelsJson" name="modelsJson" rows="9" spellcheck="false"></textarea>
              </div>
              <div class="field">
                <label for="upstreamApiKey">上游 API Key</label>
                <input id="upstreamApiKey" name="upstreamApiKey" type="password" autocomplete="off" placeholder="留空则保持当前密钥">
              </div>
              <div class="field">
                <label for="authToken">代理访问令牌</label>
                <input id="authToken" name="authToken" type="password" autocomplete="off" placeholder="留空则保持当前令牌">
              </div>
              <div class="field full checks">
                <label><input id="clearUpstreamApiKey" name="clearUpstreamApiKey" type="checkbox"> 清空上游密钥</label>
                <label><input id="clearAuthToken" name="clearAuthToken" type="checkbox"> 关闭代理令牌</label>
              </div>
            </div>
            <div class="actions">
              <button class="primary" type="submit">保存配置</button>
              <button class="secondary" id="testUpstream" type="button">测试上游</button>
              <span id="formMessage" class="message"></span>
            </div>
          </form>
        </div>
      </section>

      <section id="tab-users" class="tab-panel hidden">
        <div class="panel">
          <h2>用户管理</h2>
          <table class="table">
            <thead>
              <tr><th>用户</th><th>角色</th><th>状态</th></tr>
            </thead>
            <tbody id="usersBody"></tbody>
          </table>
        </div>
      </section>

      <section id="tab-logs" class="tab-panel hidden">
        <div class="panel">
          <h2>最近日志</h2>
          <table class="table">
            <thead>
              <tr><th>时间</th><th>级别</th><th>模块</th><th>消息</th></tr>
            </thead>
            <tbody id="logsBody"></tbody>
          </table>
        </div>
      </section>
    </section>
  </main>

  <script>
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => Array.from(document.querySelectorAll(selector));
    const state = { config: null, users: [], logs: [] };
    const titles = {
      api: ['API 配置', '模型代理、密钥与本地服务状态。'],
      users: ['用户管理', '初版占位，保留角色与状态视图。'],
      logs: ['日志', '当前进程内的最近运行记录。']
    };

    function adminToken() {
      return localStorage.getItem('turboflux.adminToken') || '';
    }

    function requestHeaders(hasBody) {
      const headers = { 'Accept': 'application/json' };
      if (hasBody) headers['Content-Type'] = 'application/json';
      const token = adminToken();
      if (token) headers['X-TurboFlux-Token'] = token;
      return headers;
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    async function api(path, options) {
      const request = options || {};
      const response = await fetch(path, {
        method: request.method || 'GET',
        headers: Object.assign(requestHeaders(Boolean(request.body)), request.headers || {}),
        body: request.body
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (!response.ok) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status;
        throw new Error(message);
      }
      return payload;
    }

    function setMessage(text, tone) {
      const el = $('#formMessage');
      el.textContent = text || '';
      el.style.color = tone === 'error' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : 'var(--muted)';
    }

    function renderStatus() {
      const cfg = state.config;
      const strip = $('#statusStrip');
      if (!cfg) {
        strip.innerHTML = '<span class="pill warn">未连接</span>';
        return;
      }
      const keyClass = cfg.upstreamKeyConfigured ? 'ok' : 'warn';
      const authClass = cfg.proxyAuth === 'enabled' ? 'ok' : '';
      strip.innerHTML =
        '<span class="pill ok">服务在线</span>' +
        '<span class="pill ' + keyClass + '">Key ' + escapeHtml(cfg.upstreamKeyConfigured ? cfg.upstreamKeyPreview : '未配置') + '</span>' +
        '<span class="pill ' + authClass + '">Auth ' + escapeHtml(cfg.proxyAuth) + '</span>' +
        '<span class="pill mono">' + escapeHtml(cfg.host) + ':' + escapeHtml(cfg.port) + '</span>';
    }

    function renderConfig() {
      const cfg = state.config;
      if (!cfg) return;
      $('#upstreamBaseUrl').value = cfg.upstreamBaseUrl || '';
      $('#defaultModel').value = cfg.defaultModel || '';
      $('#corsOrigin').value = cfg.corsOrigin || '';
      $('#modelsJson').value = JSON.stringify(cfg.models || [], null, 2);
      $('#upstreamApiKey').placeholder = cfg.upstreamKeyConfigured ? '当前：' + cfg.upstreamKeyPreview + '，留空保持' : '<upstream API key>';
      $('#authToken').placeholder = cfg.proxyAuth === 'enabled' ? '已启用，留空保持' : '可选';
      $('#clearUpstreamApiKey').checked = false;
      $('#clearAuthToken').checked = false;
      renderStatus();
    }

    function renderUsers() {
      const body = $('#usersBody');
      if (!state.users.length) {
        body.innerHTML = '<tr><td colspan="3"><div class="empty">用户管理占位</div></td></tr>';
        return;
      }
      body.innerHTML = state.users.map((user) =>
        '<tr><td class="mono">' + escapeHtml(user.name) + '</td><td>' + escapeHtml(user.role) + '</td><td>' + escapeHtml(user.status) + '</td></tr>'
      ).join('');
    }

    function renderLogs() {
      const body = $('#logsBody');
      if (!state.logs.length) {
        body.innerHTML = '<tr><td colspan="4"><div class="empty">暂无日志</div></td></tr>';
        return;
      }
      body.innerHTML = state.logs.map((log) =>
        '<tr><td class="mono">' + escapeHtml(new Date(log.time).toLocaleString()) + '</td><td>' + escapeHtml(log.level) + '</td><td>' + escapeHtml(log.area) + '</td><td>' + escapeHtml(log.message) + '</td></tr>'
      ).join('');
    }

    async function loadConfig() {
      state.config = await api('/admin/api/config');
      renderConfig();
    }

    async function loadUsers() {
      const payload = await api('/admin/api/users');
      state.users = payload.data || [];
      renderUsers();
    }

    async function loadLogs() {
      const payload = await api('/admin/api/logs');
      state.logs = payload.data || [];
      renderLogs();
    }

    async function refreshAll() {
      try {
        await Promise.all([loadConfig(), loadUsers(), loadLogs()]);
      } catch (error) {
        setMessage(error.message, 'error');
        renderStatus();
      }
    }

    function switchTab(name) {
      $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
      $$('.tab-panel').forEach((panel) => panel.classList.add('hidden'));
      $('#tab-' + name).classList.remove('hidden');
      $('#pageTitle').textContent = titles[name][0];
      $('#pageNote').textContent = titles[name][1];
      if (name === 'logs') loadLogs().catch((error) => setMessage(error.message, 'error'));
    }

    $('#configForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('保存中...', '');
      const upstreamApiKey = $('#upstreamApiKey').value.trim();
      const authToken = $('#authToken').value.trim();
      let models;
      try {
        models = JSON.parse($('#modelsJson').value || '[]');
        if (!Array.isArray(models)) throw new Error('Models JSON must be an array');
      } catch (error) {
        setMessage(error.message, 'error');
        return;
      }
      const payload = {
        upstreamBaseUrl: $('#upstreamBaseUrl').value.trim(),
        defaultModel: $('#defaultModel').value.trim(),
        models,
        corsOrigin: $('#corsOrigin').value.trim(),
        clearUpstreamApiKey: $('#clearUpstreamApiKey').checked,
        clearAuthToken: $('#clearAuthToken').checked
      };
      if (upstreamApiKey) payload.upstreamApiKey = upstreamApiKey;
      if (authToken) payload.authToken = authToken;
      try {
        state.config = await api('/admin/api/config', { method: 'PUT', body: JSON.stringify(payload) });
        $('#upstreamApiKey').value = '';
        $('#authToken').value = '';
        renderConfig();
        await loadLogs();
        setMessage('已保存', 'ok');
      } catch (error) {
        setMessage(error.message, 'error');
      }
    });

    $('#testUpstream').addEventListener('click', async () => {
      setMessage('测试中...', '');
      try {
        const payload = await api('/admin/api/config/test', { method: 'POST', body: JSON.stringify({}) });
        setMessage(payload.message || '测试通过', 'ok');
        await loadLogs();
      } catch (error) {
        setMessage(error.message, 'error');
        await loadLogs().catch(() => {});
      }
    });

    $('#saveToken').addEventListener('click', () => {
      localStorage.setItem('turboflux.adminToken', $('#adminToken').value.trim());
      setMessage('访问令牌已保存到本机浏览器', 'ok');
      refreshAll();
    });

    $$('.nav-button').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    $('#adminToken').value = adminToken();
    refreshAll();
  </script>
</body>
</html>`
