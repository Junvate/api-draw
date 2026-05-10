const STORAGE_KEYS = {
  density: "admin-density",
  view: "admin-active-view",
  sidebarCollapsed: "admin-sidebar-collapsed",
  autoRefresh: "admin-auto-refresh",
};

const AUTO_REFRESH_MS = 30000;

const state = {
  user: null,
  summary: null,
  usage: null,
  ready: null,
  users: [],
  gateways: [],
  codes: [],
  jobs: [],
  logs: [],
  selected: {
    gateways: new Set(),
    users: new Set(),
  },
  drafts: {
    gateways: {},
    users: {},
  },
  density: localStorage.getItem(STORAGE_KEYS.density) || "comfortable",
  view: localStorage.getItem(STORAGE_KEYS.view) || "channels",
  sidebarCollapsed: localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === "1",
  autoRefresh: localStorage.getItem(STORAGE_KEYS.autoRefresh) !== "off",
  refreshTimer: null,
  loadingAll: false,
  lastLoadPromise: null,
};

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const clip = (value, length = 72) => {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
};

const titles = {
  overview: ["首页", "业务健康、渠道能力和近期风险"],
  channels: ["上游渠道", "每个渠道代表一个上游入口或中转站"],
  users: ["用户", "账号状态与积分"],
  jobs: ["任务", "最近 100 条绘图请求"],
  codes: ["兑换码", "积分兑换和活动发放"],
  audit: ["审计", "最近 100 条操作记录"],
  system: ["系统", "运行探针、指标和 OpenAPI"],
  settings: ["站点设置", "前台展示与跳转配置"],
};

const searchTargets = {
  channels: "gatewaySearch",
  users: "userSearch",
  jobs: "jobSearch",
  codes: "codeSearch",
  audit: "auditSearch",
};

const ROW_DRAFT_CONFIG = {
  gateways: {
    sourceFields: ["name", "provider", "model", "baseUrl", "apiKey", "healthCheckPath", "generationPath", "upstreamGroup", "costCredits", "timeoutMs", "priority", "enabled"],
    transientFields: [],
  },
  users: {
    sourceFields: ["status"],
    transientFields: ["credits", "reason"],
  },
};

const renderers = {
  channels: renderGateways,
  users: renderUsers,
  jobs: renderJobs,
  codes: renderCodes,
  audit: renderAudit,
};

const quickActions = {
  overview: [
    ["channels", "渠道配置", "view", "channels"],
    ["jobs", "查看绘图任务", "view", "jobs"],
  ],
  channels: [
    ["gateway-check", "检测全部渠道", "click", "checkAllGateways", "green"],
    ["gateway-create", "新增中转站", "open", "gatewayCreateBox", "primary"],
    ["jobs", "查看任务队列", "view", "jobs"],
  ],
  users: [
    ["user-create", "创建用户", "open", "userCreateBox", "primary"],
    ["jobs", "查看用户任务", "view", "jobs"],
  ],
  jobs: [
    ["jobs-running", "处理中", "filter", "jobStatusFilter:running"],
    ["jobs-failed", "失败任务", "filter", "jobStatusFilter:failed", "danger"],
    ["system", "队列状态", "view", "system"],
  ],
  codes: [
    ["code-create", "创建兑换码", "open", "codeCreateBox", "primary"],
    ["users", "用户积分", "view", "users"],
    ["audit", "查看审计", "view", "audit"],
  ],
  audit: [
    ["audit-refresh", "刷新审计", "reload", "", "primary"],
    ["users", "用户管理", "view", "users"],
    ["system", "系统探针", "view", "system"],
  ],
  system: [
    ["system-reload", "刷新探针", "click", "reloadSystem", "primary"],
    ["openapi", "OpenAPI", "link", "/api/openapi.json"],
    ["metrics", "指标文本", "link", "/api/metrics"],
  ],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "请求失败");
  return payload;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function isoFromLocal(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatShortDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatRelative(value) {
  if (!value) return "从未";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "-";
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function includesText(...values) {
  const haystack = values.slice(1).join(" ").toLowerCase();
  return haystack.includes(String(values[0] || "").trim().toLowerCase());
}

function isWithin(value, hours) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() <= hours * 60 * 60 * 1000;
}

function expiresSoon(value, hours) {
  if (!value) return false;
  const diff = new Date(value).getTime() - Date.now();
  return diff <= hours * 60 * 60 * 1000;
}

function percentage(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function statusLabel(value) {
  return {
    active: "正常",
    enabled: "启用",
    disabled: "停用",
    revoked: "吊销",
    queued: "排队",
    running: "处理中",
    succeeded: "成功",
    failed: "失败",
    paid: "已支付",
    true: "启用",
    false: "停用",
    unknown: "未知",
    healthy: "健康",
    degraded: "降级",
    down: "熔断",
  }[String(value)] || String(value ?? "-");
}

function statusBadge(value) {
  const text = String(value ?? "");
  const klass = ["active", "succeeded", "paid", "enabled", "true", "healthy"].includes(text)
    ? "ok"
    : ["failed", "revoked", "disabled", "false", "down"].includes(text)
      ? "danger"
      : "warn";
  return `<span class="status ${klass}">${escapeHtml(statusLabel(text))}</span>`;
}

function fieldRow(label, value) {
  return `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `;
}

function jsonBlock(value) {
  return `<pre class="json-block">${escapeHtml(JSON.stringify(value || {}, null, 2))}</pre>`;
}

function statCard(label, value, hint = "", percent = null) {
  const bar = percent === null ? "" : `<div class="progress"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>`;
  return `
    <div class="stat-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
      ${bar}
    </div>
  `;
}

function statusCard(label, value, hint = "", percent = null) {
  const bar = percent === null ? "" : `<div class="progress"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>`;
  return `
    <div class="status-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
      ${bar}
    </div>
  `;
}

function tableEmpty(colspan, text = "没有匹配的数据") {
  return `<tr><td colspan="${colspan}" class="empty-row">${escapeHtml(text)}</td></tr>`;
}

function isCoolingDown(gateway) {
  return gateway.disabledUntil && new Date(gateway.disabledUntil).getTime() > Date.now();
}

function formatLatency(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return number >= 1000 ? `${(number / 1000).toFixed(1)}s` : `${number}ms`;
}

function adminJobResultUrl(job) {
  if (!job?.resultUrl) return "";
  return job.resultUrl;
}

function toast(message, type = "info") {
  const stack = $("toastStack");
  while (stack.children.length >= 3) stack.firstElementChild?.remove();
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.setAttribute("role", type === "error" ? "alert" : "status");
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => item.remove(), 2600);
}

async function withBusy(element, label, task) {
  const previousText = element?.textContent;
  if (element) {
    element.disabled = true;
    if (label) element.textContent = label;
  }
  try {
    return await task();
  } finally {
    if (element) {
      element.disabled = false;
      if (label) element.textContent = previousText;
    }
  }
}

function setAdminVisible(visible) {
  document.body.classList.toggle("admin-auth-locked", !visible);
  $("loginPanel").classList.toggle("hidden", visible);
  $("content").classList.toggle("hidden", !visible);
  if (!visible) stopAutoRefresh();
}

function activeView() {
  return document.querySelector(".view.active")?.dataset.panel || "channels";
}

function applyDensity() {
  document.body.classList.add("density-compact");
}

function applyShellState() {
  document.body.classList.toggle("admin-sidebar-collapsed", state.sidebarCollapsed);
  const button = document.querySelector(".menu-button");
  if (!button) return;
  button.textContent = state.sidebarCollapsed ? "→" : "☰";
  button.setAttribute("aria-label", state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏");
  button.setAttribute("title", state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏");
}

function stopAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefresh || !state.user || document.hidden) return;
  state.refreshTimer = window.setInterval(() => {
    loadAll().catch(() => {});
  }, AUTO_REFRESH_MS);
}

function applyAutoRefresh() {
  $("autoRefreshButton").textContent = !state.autoRefresh ? "自动刷新关" : hasDirtyDrafts() ? "自动刷新暂停" : "自动刷新开";
  startAutoRefresh();
}

function getEditableEntity(type, id) {
  if (type === "gateways") return state.gateways.find((item) => item.id === id) || null;
  if (type === "users") return state.users.find((item) => item.id === id) || null;
  return null;
}

function getRowDraft(type, id) {
  return state.drafts[type]?.[id] || {};
}

function rawSourceFieldValue(type, entity, field) {
  if (!entity) return "";
  if (type === "gateways") {
    if (field === "enabled") return entity.enabled ? "true" : "false";
    if (["costCredits", "timeoutMs", "priority"].includes(field)) return String(Number(entity[field] ?? 0));
    if (field === "apiKey") return entity.apiKey || "";
    return String(entity[field] ?? "");
  }
  if (type === "users") {
    if (field === "status") return String(entity[field] ?? "");
    return "";
  }
  return "";
}

function normalizeDraftValue(type, field, value) {
  if (type === "gateways" && ["costCredits", "timeoutMs", "priority"].includes(field)) return Number(value || 0);
  if (type === "gateways" && field === "enabled") return value === true || value === "true";
  return String(value ?? "").trim();
}

function isDirtyDraftField(type, entity, field, rawValue) {
  const config = ROW_DRAFT_CONFIG[type];
  if (!config) return false;
  if (config.transientFields.includes(field)) {
    if (field === "credits") return String(rawValue ?? "").trim() !== "" && Number(rawValue) !== 0;
    return String(rawValue ?? "").trim() !== "";
  }
  if (type === "gateways" && field === "apiKey" && rawValue === entity?.apiKey) return false;
  return normalizeDraftValue(type, field, rawValue) !== normalizeDraftValue(type, field, rawSourceFieldValue(type, entity, field));
}

function rowInputValue(type, id, field, entity) {
  const draft = getRowDraft(type, id);
  return draft[field] ?? rawSourceFieldValue(type, entity, field);
}

function getRowDraftState(type, id) {
  const draft = getRowDraft(type, id);
  const config = ROW_DRAFT_CONFIG[type];
  const sourceDirty = config.sourceFields.some((field) => Object.prototype.hasOwnProperty.call(draft, field));
  const transientDirty = config.transientFields.some((field) => Object.prototype.hasOwnProperty.call(draft, field));
  const validTransientAction = type === "users"
    ? String(draft.credits ?? "").trim() !== "" && Number(draft.credits) !== 0
    : false;
  return {
    anyDirty: Object.keys(draft).length > 0,
    sourceDirty,
    transientDirty,
    validTransientAction,
    draft,
  };
}

function formatDraftStateLabel(draftState) {
  if (draftState.sourceDirty && draftState.transientDirty) return "未保存 · 待调额";
  if (draftState.sourceDirty) return "未保存";
  if (draftState.transientDirty) return "待调额";
  return "";
}

function hasDirtyDrafts() {
  return Object.values(state.drafts).some((group) => Object.keys(group).length > 0);
}

function setRowDraftField(type, id, field, value) {
  const entity = getEditableEntity(type, id);
  if (!entity || !ROW_DRAFT_CONFIG[type]) return;

  const nextDraft = { ...getRowDraft(type, id), [field]: value };
  const cleanedDraft = Object.fromEntries(
    Object.entries(nextDraft).filter(([draftField, draftValue]) => isDirtyDraftField(type, entity, draftField, draftValue)),
  );

  if (Object.keys(cleanedDraft).length > 0) state.drafts[type][id] = cleanedDraft;
  else delete state.drafts[type][id];

  applyAutoRefresh();
}

function clearRowDraft(type, id, fields = null) {
  if (!state.drafts[type]?.[id]) return;
  if (!fields) {
    delete state.drafts[type][id];
  } else {
    fields.forEach((field) => delete state.drafts[type][id][field]);
    if (Object.keys(state.drafts[type][id]).length === 0) delete state.drafts[type][id];
  }
  applyAutoRefresh();
}

function pruneDrafts() {
  Object.keys(state.drafts).forEach((type) => {
    Object.entries(state.drafts[type]).forEach(([id, draft]) => {
      const entity = getEditableEntity(type, id);
      if (!entity) {
        delete state.drafts[type][id];
        return;
      }

      const cleanedDraft = Object.fromEntries(
        Object.entries(draft).filter(([field, value]) => isDirtyDraftField(type, entity, field, value)),
      );

      if (Object.keys(cleanedDraft).length > 0) state.drafts[type][id] = cleanedDraft;
      else delete state.drafts[type][id];
    });
  });
  applyAutoRefresh();
}

function syncDirtyRowUi(row, type, id) {
  const draftState = getRowDraftState(type, id);
  row.classList.toggle("is-dirty", draftState.anyDirty);
  row.querySelectorAll("[data-field]").forEach((field) => {
    field.classList.toggle("is-dirty", Object.prototype.hasOwnProperty.call(draftState.draft, field.dataset.field));
  });

  const saveAction = type === "gateways" ? "save-gateway" : "save-user";
  const resetAction = type === "gateways" ? "reset-gateway" : "reset-user";
  const saveButton = row.querySelector(`[data-action="${saveAction}"]`);
  const resetButton = row.querySelector(`[data-action="${resetAction}"]`);
  const adjustButton = row.querySelector('[data-action="adjust-credits"]');
  const draftBadge = row.querySelector('[data-role="draft-status"]');

  if (saveButton) saveButton.disabled = !draftState.sourceDirty;
  if (resetButton) resetButton.disabled = !draftState.anyDirty;
  if (adjustButton) adjustButton.disabled = !draftState.validTransientAction;

  if (draftBadge) {
    const label = formatDraftStateLabel(draftState);
    draftBadge.textContent = label;
    draftBadge.classList.toggle("hidden", !label);
    draftBadge.classList.toggle("adjust", draftState.transientDirty && !draftState.sourceDirty);
    draftBadge.classList.toggle("mixed", draftState.sourceDirty && draftState.transientDirty);
  }
}

function captureRowDraft(type, fieldElement) {
  const row = fieldElement.closest("tr");
  if (!row) return;
  setRowDraftField(type, row.dataset.id, fieldElement.dataset.field, fieldElement.value);
  syncDirtyRowUi(row, type, row.dataset.id);
}

function resetTransientUi({ keepLoginMessage = false } = {}) {
  closeDrawer();
  $("newKeyBox")?.classList.add("hidden");
  if ($("newKeyToken")) $("newKeyToken").textContent = "";
  $("bulkCreditAmount").value = "";
  $("bulkCreditReason").value = "";
  if (!keepLoginMessage) $("loginMessage").textContent = "";
}

function clearAdminData() {
  state.summary = null;
  state.usage = null;
  state.ready = null;
  state.users = [];
  state.gateways = [];
  state.codes = [];
  state.jobs = [];
  state.logs = [];
  state.selected.gateways.clear();
  state.selected.users.clear();
  state.drafts.gateways = {};
  state.drafts.users = {};
  $("adminIdentity").textContent = "未登录";
  $("sideHealth").textContent = "未连接";
  $("sideHealthMeta").textContent = "等待检查";
  $("lastRefresh").textContent = "未刷新";
  [
    "navOverviewCount",
    "navChannelCount",
    "navUserCount",
    "navJobCount",
    "navCodeCount",
    "navAuditCount",
    "navSystemCount",
  ].forEach((id) => { $(id).textContent = "-"; });
}

function upsertById(items, nextItem) {
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) items.unshift(nextItem);
  else items.splice(index, 1, { ...items[index], ...nextItem });
}

function adjustSummaryForCreditChange(amount) {
  if (!state.summary) return;
  if (amount > 0) state.summary.creditIssued = Number(state.summary.creditIssued || 0) + amount;
  if (amount < 0) state.summary.creditSpent = Number(state.summary.creditSpent || 0) + Math.abs(amount);
}

function appendAuditLog(action, targetId, meta) {
  if (!state.user) return;
  state.logs.unshift({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actorId: state.user.id,
    actorEmail: state.user.email,
    actorName: state.user.name,
    action,
    targetId,
    meta: meta || {},
    createdAt: new Date().toISOString(),
  });
  state.logs = state.logs.slice(0, 100);
}

function rerenderAfterMutation() {
  pruneSelections();
  pruneDrafts();
  renderAll();
  if (activeView() === "system" && state.ready) {
    $("readyJson").textContent = JSON.stringify(state.ready, null, 2);
  }
}

async function ensureAdmin() {
  try {
    const { user } = await api("/api/me");
    if (!user) {
      state.user = null;
      clearAdminData();
      setAdminVisible(false);
      return;
    }
    state.user = user;
    $("loginMessage").textContent = "";
    $("adminIdentity").textContent = `${user.name} · ${user.email}`;
    if (user.role !== "admin") {
      setAdminVisible(false);
      $("loginMessage").textContent = "当前账号没有管理员权限";
      return;
    }
    setAdminVisible(true);
    resetTransientUi({ keepLoginMessage: true });
    await loadAll();
    applyAutoRefresh();
  } catch (error) {
    state.user = null;
    clearAdminData();
    setAdminVisible(false);
    if (error.message !== "请先登录") $("loginMessage").textContent = error.message;
  }
}

async function loadAll() {
  if (state.loadingAll && state.lastLoadPromise) return state.lastLoadPromise;
  state.loadingAll = true;
  state.lastLoadPromise = (async () => {
    try {
      const [summary, usage, users, gateways, codes, jobs, logs, ready] = await Promise.all([
        api("/api/admin/summary"),
        api("/api/admin/usage?days=14"),
        api("/api/admin/users"),
        api("/api/admin/gateways"),
        api("/api/admin/redemption-codes"),
        api("/api/admin/jobs"),
        api("/api/admin/audit-logs"),
        api("/api/ready"),
      ]);
      state.summary = summary;
      state.usage = usage;
      state.users = users.users;
      state.gateways = gateways.gateways;
      state.codes = codes.codes;
      state.jobs = jobs.jobs;
      state.logs = logs.logs;
      state.ready = ready;
      pruneSelections();
      pruneDrafts();
      renderRuntime(ready);
      renderAll();
      if (activeView() === "system") await loadSystem();
    } catch (error) {
      $("sideHealth").textContent = "连接失败";
      $("sideHealthMeta").textContent = error.message;
      $("lastRefresh").textContent = "刷新失败";
      toast(error.message, "error");
      throw error;
    } finally {
      state.loadingAll = false;
      state.lastLoadPromise = null;
    }
  })();
  return state.lastLoadPromise;
}

function pruneSelections() {
  const gatewayIds = new Set(state.gateways.map((item) => item.id));
  const userIds = new Set(state.users.map((item) => item.id));
  state.selected.gateways.forEach((id) => { if (!gatewayIds.has(id)) state.selected.gateways.delete(id); });
  state.selected.users.forEach((id) => { if (!userIds.has(id)) state.selected.users.delete(id); });
}

function renderRuntime(ready) {
  $("redisChip").textContent = `Redis ${ready.redis ? "正常" : "未启用"}`;
  $("redisChip").className = `chip ${ready.redis ? "ok" : "warn"}`;
  $("gatewayChip").textContent = `并发 ${ready.gateway?.active || 0}/${ready.gateway?.concurrency || 0}`;
  $("gatewayChip").className = `chip ${(ready.gateway?.active || 0) > 0 ? "ok" : "warn"}`;
  $("sideHealth").textContent = ready.ok ? "服务正常" : "服务异常";
  $("sideHealthMeta").textContent = `${ready.redis ? "Redis 已连接" : "Redis 未启用"} · 并发 ${ready.gateway?.concurrency || 0}`;
  $("lastRefresh").textContent = `刷新于 ${formatShortDate(new Date())}`;
}

function renderAll() {
  renderNavCounts();
  renderOverview();
  renderUsage();
  renderGateways();
  renderUsers();
  renderJobs();
  renderCodes();
  renderAudit();
}

function renderNavCounts() {
  const activeGateways = state.gateways.filter((gateway) => gateway.enabled).length;
  const activeUsers = state.users.filter((user) => user.status === "active").length;
  const openJobs = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const activeCodes = state.codes.filter((code) => code.active).length;
  $("navOverviewCount").textContent = `${state.jobs.length}`;
  $("navChannelCount").textContent = `${activeGateways}/${state.gateways.length}`;
  $("navUserCount").textContent = `${activeUsers}/${state.users.length}`;
  $("navJobCount").textContent = openJobs ? `${openJobs} 待` : `${state.jobs.length}`;
  $("navCodeCount").textContent = `${activeCodes}/${state.codes.length}`;
  $("navAuditCount").textContent = `${state.logs.length}`;
  $("navSystemCount").textContent = state.ready?.redis ? "Redis" : "本地";
}

function renderOverview() {
  const summary = state.summary || {};
  const todayJobs = state.jobs.filter((job) => isWithin(job.createdAt, 24));
  const succeeded = state.jobs.filter((job) => job.status === "succeeded").length;
  const failed = state.jobs.filter((job) => job.status === "failed").length;
  const activeGateways = state.gateways.filter((gateway) => gateway.enabled).length;
  const metrics = [
    ["用户", summary.users || 0, `${state.users.filter((user) => user.status === "active").length} 个正常账号`],
    ["可用渠道", `${activeGateways}/${state.gateways.length}`, "按优先级调度"],
    ["今日任务", todayJobs.length, "过去 24 小时"],
    ["成功率", `${percentage(succeeded, succeeded + failed)}%`, `${succeeded + failed} 个已完成任务`],
    ["消耗积分", summary.creditSpent || 0, `累计发放 ${summary.creditIssued || 0}`],
    ["启用兑换码", state.codes.filter((code) => code.active).length, `${state.codes.length} 个库存`],
  ];
  $("metricGrid").innerHTML = metrics.map(([label, value, hint]) => `
    <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></div>
  `).join("");

  renderOpsChecklist();
  renderJobStatusBoard();
  renderAccountBoard();

  const gateways = state.gateways.slice().sort((a, b) => b.priority - a.priority);
  $("overviewGateways").innerHTML = gateways.map((gateway) => `
    <div class="compact-item" data-open-detail="gateway" data-id="${escapeHtml(gateway.id)}">
      <div>
        <strong>${escapeHtml(gateway.name)}</strong>
        <span>${escapeHtml(gateway.provider)} · ${escapeHtml(gateway.model)} · ${gateway.costCredits} 积分 · ${formatLatency(gateway.lastLatencyMs)}</span>
      </div>
      ${statusBadge(gateway.enabled ? (isCoolingDown(gateway) ? "down" : (gateway.healthStatus || "unknown")) : "disabled")}
    </div>
  `).join("") || `<div class="compact-item"><span>暂无渠道</span></div>`;

  $("overviewJobs").innerHTML = state.jobs.slice(0, 6).map((job) => `
    <div class="compact-item" data-open-detail="job" data-id="${escapeHtml(job.id)}">
      <div>
        <strong>${escapeHtml(job.model || "-")} · ${escapeHtml(job.userEmail || "-")}</strong>
        <span>${escapeHtml(clip(job.prompt, 54))}</span>
      </div>
      ${statusBadge(job.status)}
    </div>
  `).join("") || `<div class="compact-item"><span>暂无任务</span></div>`;
}

function renderUsage() {
  const usage = state.usage || { daily: [], byModel: [], byGateway: [], totals: {} };
  const maxJobs = Math.max(1, ...usage.daily.map((day) => day.jobs));
  $("usageChart").innerHTML = usage.daily.map((day) => {
    const height = Math.max(8, Math.round((day.jobs / maxJobs) * 180));
    const failed = Number(day.failed || 0) > 0;
    return `
      <div class="usage-day ${failed ? "failed" : ""}" title="${escapeHtml(day.date)} · ${day.jobs} 任务 · ${day.credits} 积分">
        <div class="usage-bar" style="height:${height}px"></div>
        <small>${escapeHtml(day.date.slice(5))}</small>
      </div>
    `;
  }).join("") || `<div class="empty-row">暂无用量数据</div>`;

  $("usageModelList").innerHTML = `
    <div class="usage-list">
      <h3>模型用量</h3>
      ${(usage.byModel || []).slice(0, 5).map((item) => `
        <div class="usage-row"><span>${escapeHtml(item.model)}</span><strong>${item.jobs}</strong></div>
      `).join("") || `<div class="usage-row"><span>暂无数据</span><strong>0</strong></div>`}
    </div>
  `;

  const gatewayNames = new Map(state.gateways.map((gateway) => [gateway.id, gateway.name]));
  $("usageGatewayList").innerHTML = `
    <div class="usage-list">
      <h3>渠道用量</h3>
      ${(usage.byGateway || []).slice(0, 5).map((item) => `
        <div class="usage-row"><span>${escapeHtml(gatewayNames.get(item.gatewayId) || item.gatewayId)}</span><strong>${item.jobs}</strong></div>
      `).join("") || `<div class="usage-row"><span>暂无数据</span><strong>0</strong></div>`}
    </div>
  `;
}

function renderOpsChecklist() {
  const items = [];
  const activeGateways = state.gateways.filter((gateway) => gateway.enabled);
  const downGateways = state.gateways.filter((gateway) => gateway.healthStatus === "down" || isCoolingDown(gateway)).length;
  const failed24h = state.jobs.filter((job) => job.status === "failed" && isWithin(job.createdAt, 24)).length;
  const pending = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const lowCreditUsers = state.users.filter((user) => Number(user.credits || 0) < 20 && user.status === "active").length;

  if (!state.ready?.redis) items.push(["warn", "Redis 未启用", "高并发部署建议使用 Redis 分布式队列和限流。", "system"]);
  if (!activeGateways.length) items.push(["danger", "没有启用渠道", "用户请求会因为没有可用网关而失败。", "channels"]);
  if (downGateways) items.push(["danger", `${downGateways} 个渠道处于熔断/冷却`, "调度器会临时跳过这些渠道。", "channels"]);
  if (failed24h) items.push(["danger", `近 24 小时 ${failed24h} 个失败任务`, "建议查看任务和上游渠道配置。", "jobs"]);
  if (pending) items.push(["warn", `${pending} 个任务等待处理`, "队列有积压时需要关注并发和网关超时。", "jobs"]);
  if (lowCreditUsers) items.push(["warn", `${lowCreditUsers} 个低余额用户`, "可通过用户页进行积分补发或商务跟进。", "users"]);
  if (!items.length) items.push(["ok", "暂无待办", "渠道、任务与用户积分状态稳定。", "overview"]);

  $("opsChecklist").innerHTML = items.map(([level, title, detail, view]) => `
    <div class="ops-item ${level}">
      <span class="ops-dot"></span>
      <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div>
      ${view === "overview" ? statusBadge("active") : `<button data-view-jump="${view}" type="button">处理</button>`}
    </div>
  `).join("");
}

function renderJobStatusBoard() {
  const counts = countBy(state.jobs, (job) => job.status || "unknown");
  const total = state.jobs.length;
  const cards = [
    ["成功", counts.succeeded || 0, "已完成并返回结果"],
    ["失败", counts.failed || 0, "需要排查提示词或上游"],
    ["排队", counts.queued || 0, "等待 worker 消费"],
    ["处理中", counts.running || 0, "已进入网关调用"],
  ];
  $("jobStatusBoard").innerHTML = cards.map(([label, value, hint]) => statusCard(label, value, hint, percentage(value, total))).join("");
}

function renderAccountBoard() {
  const totalCredits = state.users.reduce((sum, user) => sum + Number(user.credits || 0), 0);
  const activeUsers = state.users.filter((user) => user.status === "active").length;
  const disabledUsers = state.users.filter((user) => user.status === "disabled").length;
  $("accountBoard").innerHTML = [
    statusCard("正常用户", activeUsers, `${state.users.length} 个账号`, percentage(activeUsers, state.users.length)),
    statusCard("停用用户", disabledUsers, "不可继续使用"),
    statusCard("积分余额", totalCredits, "所有用户合计"),
    statusCard("低余额用户", state.users.filter((user) => Number(user.credits || 0) < 20 && user.status === "active").length, "低于 20 积分"),
  ].join("");
}

function filteredGateways() {
  const search = $("gatewaySearch").value;
  const status = $("gatewayStatusFilter").value;
  const provider = $("gatewayProviderFilter").value;
  return state.gateways
    .filter((gateway) => !provider || gateway.provider === provider)
    .filter((gateway) => !status || (status === "enabled" ? gateway.enabled : !gateway.enabled))
    .filter((gateway) => includesText(search, gateway.name, gateway.provider, gateway.model, gateway.baseUrl, gateway.id))
    .sort((a, b) => b.priority - a.priority);
}

function renderGatewayStats() {
  const enabled = state.gateways.filter((gateway) => gateway.enabled).length;
  const healthy = state.gateways.filter((gateway) => gateway.healthStatus === "healthy").length;
  const down = state.gateways.filter((gateway) => gateway.healthStatus === "down" || isCoolingDown(gateway)).length;
  const cooling = state.gateways.filter(isCoolingDown).length;
  const avgCost = state.gateways.length
    ? Math.round(state.gateways.reduce((sum, gateway) => sum + Number(gateway.costCredits || 0), 0) / state.gateways.length)
    : 0;
  $("gatewayStats").innerHTML = [
    statCard("启用渠道", `${enabled}/${state.gateways.length}`, "参与调度的上游"),
    statCard("健康渠道", healthy, "最近检测或调用成功"),
    statCard("熔断/冷却", down, cooling ? `${cooling} 个正在冷却` : "不可被调度"),
    statCard("平均成本", `${avgCost} 积分`, "按上游渠道配置估算"),
  ].join("");
}

function renderGateways() {
  renderGatewayStats();
  const rows = filteredGateways();

  $("gatewayRows").innerHTML = rows.map((gateway) => {
    const draftState = getRowDraftState("gateways", gateway.id);
    const cooling = isCoolingDown(gateway);
    const providerLabel = rowInputValue("gateways", gateway.id, "provider", gateway) === "openai" ? "OpenAI 兼容" : rowInputValue("gateways", gateway.id, "provider", gateway);
    const enabledValue = rowInputValue("gateways", gateway.id, "enabled", gateway) === "true";
    return `
    <tr data-id="${gateway.id}" class="${draftState.anyDirty ? "is-dirty" : ""}">
      <td class="select-col"><input type="checkbox" data-select="gateway" ${state.selected.gateways.has(gateway.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(gateway.name)}" /></td>
      <td>
        <div class="cell-stack gateway-identity">
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "name") ? "is-dirty" : ""}" data-field="name" value="${escapeHtml(rowInputValue("gateways", gateway.id, "name", gateway))}" />
          <div class="gateway-meta-tags">
            <span class="gateway-tag provider-tag">${escapeHtml(providerLabel)}</span>
          </div>
          <select class="gateway-provider-select ${Object.prototype.hasOwnProperty.call(draftState.draft, "provider") ? "is-dirty" : ""}" data-field="provider"><option value="openai" ${rowInputValue("gateways", gateway.id, "provider", gateway) === "openai" ? "selected" : ""}>OpenAI 兼容</option></select>
        </div>
      </td>
      <td>
        <div class="cell-stack wide-field gateway-endpoint">
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "model") ? "is-dirty" : ""}" data-field="model" value="${escapeHtml(rowInputValue("gateways", gateway.id, "model", gateway))}" />
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "baseUrl") ? "is-dirty" : ""}" data-field="baseUrl" value="${escapeHtml(rowInputValue("gateways", gateway.id, "baseUrl", gateway))}" />
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "generationPath") ? "is-dirty" : ""}" data-field="generationPath" value="${escapeHtml(rowInputValue("gateways", gateway.id, "generationPath", gateway) || "/images/generations")}" />
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "upstreamGroup") ? "is-dirty" : ""}" data-field="upstreamGroup" value="${escapeHtml(rowInputValue("gateways", gateway.id, "upstreamGroup", gateway))}" placeholder="分组，可选" />
          <input class="${Object.prototype.hasOwnProperty.call(draftState.draft, "apiKey") ? "is-dirty" : ""}" data-field="apiKey" type="password" value="${escapeHtml(rowInputValue("gateways", gateway.id, "apiKey", gateway))}" placeholder="${gateway.apiKeyConfigured ? "留空则保持当前 Key，不留明文回显" : "填写真实 API Key"}" />
        </div>
      </td>
      <td>
        <div class="cell-stack gateway-cost">
          <input class="num-input ${Object.prototype.hasOwnProperty.call(draftState.draft, "costCredits") ? "is-dirty" : ""}" data-field="costCredits" type="number" value="${escapeHtml(rowInputValue("gateways", gateway.id, "costCredits", gateway))}" />
          <small>每次调用消耗积分</small>
        </div>
      </td>
      <td>
        <div class="row-actions gateway-actions gateway-compact-actions">
          <button class="state-toggle ${enabledValue ? "is-on" : ""} ${Object.prototype.hasOwnProperty.call(draftState.draft, "enabled") ? "is-dirty" : ""}" data-action="toggle-gateway" type="button" aria-label="${enabledValue ? "停用渠道" : "启用渠道"}">${enabledValue ? "启用" : "停用"}</button>
          <button class="small primary" data-action="save-gateway" ${draftState.sourceDirty ? "" : "disabled"}>保存</button>
          <button class="icon-only" data-action="gateway-menu" type="button" aria-label="更多操作">···</button>
          <span class="dirty-pill ${draftState.anyDirty ? "" : "hidden"}" data-role="draft-status">${escapeHtml(formatDraftStateLabel(draftState))}</span>
        </div>
      </td>
    </tr>
  `;
  }).join("") || tableEmpty(5);
  syncSelection("gateways", rows.map((item) => item.id), "gatewaySelectAll", "gatewayBulkBar", "gatewaySelectedCount", "已选择 0 个渠道");
}

function filteredUsers() {
  const search = $("userSearch").value;
  return state.users
    .filter((user) => includesText(search, user.email, user.name, user.id));
}

function renderUserStats() {
  const userCount = state.users.length;
  const totalCredits = state.users.reduce((sum, user) => sum + Number(user.credits || 0), 0);
  $("userStats").innerHTML = [
    statCard("用户数", userCount, "当前账号总数"),
    statCard("低余额用户", state.users.filter((user) => Number(user.credits || 0) < 20).length, "需要补充积分"),
    statCard("积分余额", totalCredits, "所有用户合计"),
    statCard("平均积分", userCount ? Math.round(totalCredits / userCount) : 0, "按用户均值估算"),
  ].join("");
}

function renderUsers() {
  renderUserStats();
  const rows = filteredUsers();

  $("userRows").innerHTML = rows.map((user) => {
    const draftState = getRowDraftState("users", user.id);
    return `
    <tr data-id="${user.id}" class="${draftState.anyDirty ? "is-dirty" : ""}">
      <td class="select-col"><input type="checkbox" data-select="user" ${state.selected.users.has(user.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(user.email)}" /></td>
      <td>
        <div class="cell-stack">
          <strong>${escapeHtml(user.email)}</strong>
          <small>${escapeHtml(user.name)}</small>
        </div>
      </td>
      <td><strong>${Number(user.credits || 0)}</strong></td>
      <td><div class="row-actions user-row-actions"><button class="small primary" data-action="save-user" ${draftState.sourceDirty ? "" : "disabled"}>保存</button><button class="icon-only" data-action="user-menu" aria-label="更多操作">···</button><span class="dirty-pill ${draftState.anyDirty ? "" : "hidden"}" data-role="draft-status">${escapeHtml(formatDraftStateLabel(draftState))}</span></div></td>
    </tr>
  `;
  }).join("") || tableEmpty(4);
  syncSelection("users", rows.map((item) => item.id), "userSelectAll", "userBulkBar", "userSelectedCount", "已选择 0 个用户");
}

function renderJobStats() {
  const counts = countBy(state.jobs, (job) => job.status || "unknown");
  const today = state.jobs.filter((job) => isWithin(job.createdAt, 24)).length;
  const credits = state.jobs.reduce((sum, job) => sum + Number(job.costCredits || 0), 0);
  $("jobStats").innerHTML = [
    statCard("任务总数", state.jobs.length, "最近列表范围"),
    statCard("成功", counts.succeeded || 0, "已完成"),
    statCard("失败", counts.failed || 0, "需关注"),
    statCard("今日提交", today, `${credits} 积分消耗`),
  ].join("");
}

function renderJobs() {
  renderJobStats();
  const search = $("jobSearch").value;
  const status = $("jobStatusFilter").value;
  const rows = state.jobs
    .filter((job) => !status || job.status === status)
    .filter((job) => includesText(search, job.id, job.userEmail, job.userName, job.model, job.prompt, job.status, job.gatewayId));

  $("jobRows").innerHTML = rows.map((job) => `
    <tr data-id="${job.id}">
      <td><div class="cell-stack"><strong>${escapeHtml(job.model || "image-task")}</strong><small>${escapeHtml(job.gatewayId || "")}</small></div></td>
      <td>${escapeHtml(job.userEmail || job.userId)}</td>
      <td>${escapeHtml(job.model)}</td>
      <td>${statusBadge(job.status)}</td>
      <td>${Number(job.costCredits || 0)}</td>
      <td title="${escapeHtml(job.prompt || "")}">${escapeHtml(clip(job.prompt, 92))}</td>
      <td>${formatDate(job.createdAt)}</td>
      <td><div class="row-actions task-row-actions"><button class="icon-only" data-action="job-menu" aria-label="更多操作">···</button></div></td>
    </tr>
  `).join("") || tableEmpty(8);
}

function renderCodeStats() {
  const active = state.codes.filter((code) => code.active).length;
  const totalCredits = state.codes.reduce((sum, code) => sum + Number(code.credits || 0) * Number(code.maxUses || 0), 0);
  const used = state.codes.reduce((sum, code) => sum + (code.usedBy || []).length, 0);
  $("codeStats").innerHTML = [
    statCard("启用兑换码", `${active}/${state.codes.length}`, "可被用户兑换"),
    statCard("总可发积分", totalCredits, "按最大使用次数估算"),
    statCard("已使用", used, "累计兑换次数"),
    statCard("未用完", state.codes.filter((code) => (code.usedBy || []).length < code.maxUses).length, "仍有库存"),
  ].join("");
}

function renderCodes() {
  renderCodeStats();
  const search = $("codeSearch").value;
  const status = $("codeStatusFilter").value;
  const rows = state.codes
    .filter((code) => !status || (status === "active" ? code.active : !code.active))
    .filter((code) => includesText(search, code.code, code.activityKey));

  $("codeRows").innerHTML = rows.map((code) => `
    <tr data-id="${code.id}">
      <td><strong>${escapeHtml(code.code)}</strong></td>
      <td><code>${escapeHtml(code.activityKey || code.code)}</code></td>
      <td>${Number(code.credits || 0)}</td>
      <td>${(code.usedBy || []).length}/${code.maxUses}</td>
      <td>${formatDate(code.expiresAt)}</td>
      <td>${statusBadge(code.active ? "enabled" : "disabled")}</td>
      <td><button class="small ${code.active ? "danger" : ""}" data-action="toggle-code">${code.active ? "停用" : "启用"}</button></td>
    </tr>
  `).join("") || tableEmpty(7);
}

function renderAuditStats() {
  const today = state.logs.filter((log) => isWithin(log.createdAt, 24)).length;
  const actions = new Set(state.logs.map((log) => log.action)).size;
  $("auditStats").innerHTML = [
    statCard("日志数", state.logs.length, "最近列表范围"),
    statCard("今日操作", today, "过去 24 小时"),
    statCard("动作类型", actions, "已记录的后台行为"),
    statCard("操作者", new Set(state.logs.map((log) => log.actorId)).size, "涉及账号"),
  ].join("");
}

function renderAudit() {
  renderAuditStats();
  const search = $("auditSearch").value;
  const rows = state.logs.filter((log) => includesText(search, log.actorEmail, log.actorName, log.action, log.targetId, JSON.stringify(log.meta || {})));
  $("auditRows").innerHTML = rows.map((log) => {
    const meta = JSON.stringify(log.meta || {});
    const displayMeta = meta.length > 180 ? `${meta.slice(0, 180)}...` : meta;
    return `
      <tr data-id="${log.id}">
        <td>${formatDate(log.createdAt)}</td>
        <td><div class="cell-stack"><strong>${escapeHtml(log.actorEmail || log.actorId)}</strong><small>${escapeHtml(log.actorName || "")}</small></div></td>
        <td>${escapeHtml(log.action)}</td>
        <td><code>${escapeHtml(log.targetId)}</code></td>
        <td><button class="inline-detail" data-action="detail-audit" type="button">${escapeHtml(displayMeta)}</button></td>
      </tr>
    `;
  }).join("") || tableEmpty(5);
}

function openDrawer(title, subtitle, body) {
  $("drawerTitle").textContent = title;
  $("drawerSubtitle").textContent = subtitle || "";
  $("drawerBody").innerHTML = body;
  $("drawerScrim").classList.remove("hidden");
  $("detailDrawer").classList.remove("hidden");
  $("detailDrawer").setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  $("drawerScrim").classList.add("hidden");
  $("detailDrawer").classList.add("hidden");
  $("detailDrawer").setAttribute("aria-hidden", "true");
}

function showGatewayDetail(id) {
  const gateway = state.gateways.find((item) => item.id === id);
  if (!gateway) return;
  openDrawer(gateway.name, `${gateway.provider} · ${gateway.model}`, `
    <div class="detail-section">
      <h3>调度信息</h3>
      ${fieldRow("状态", gateway.enabled ? "启用" : "停用")}
      ${fieldRow("健康", statusLabel(isCoolingDown(gateway) ? "down" : (gateway.healthStatus || "unknown")))}
      ${fieldRow("优先级", gateway.priority)}
      ${fieldRow("单次积分", gateway.costCredits)}
      ${fieldRow("超时", `${gateway.timeoutMs || 0} ms`)}
    </div>
    <div class="detail-section">
      <h3>上游配置</h3>
      ${fieldRow("Base URL", gateway.baseUrl)}
      ${fieldRow("测试路径", gateway.healthCheckPath || "/models")}
      ${fieldRow("生成路径", gateway.generationPath || "/images/generations")}
      ${fieldRow("上游分组", gateway.upstreamGroup || "-")}
      ${fieldRow("API Key", gateway.apiKey || (gateway.apiKeyConfigured ? "已配置" : "-"))}
      ${fieldRow("最近检测", formatDate(gateway.lastCheckedAt))}
      ${fieldRow("最近成功", formatDate(gateway.lastSuccessAt))}
      ${fieldRow("最近失败", formatDate(gateway.lastFailureAt))}
      ${fieldRow("最近延迟", formatLatency(gateway.lastLatencyMs))}
      ${fieldRow("连续失败", Number(gateway.consecutiveFailures || 0))}
      ${fieldRow("冷却到", formatDate(gateway.disabledUntil))}
      ${fieldRow("错误", gateway.lastError || "-")}
    </div>
  `);
}

function showGatewayMenu(id) {
  const gateway = state.gateways.find((item) => item.id === id);
  if (!gateway) return;
  const draftState = getRowDraftState("gateways", id);
  const cooling = isCoolingDown(gateway);
  const healthValue = cooling ? "down" : (gateway.healthStatus || "unknown");
  openDrawer(gateway.name, `${gateway.provider} · ${gateway.model}`, `
    <div class="detail-section">
      <h3>快捷操作</h3>
      <div class="drawer-action-list">
        <button class="drawer-action" type="button" data-drawer-action="detail-gateway" data-gateway-id="${escapeHtml(gateway.id)}">查看详情</button>
        <button class="drawer-action" type="button" data-drawer-action="check-gateway" data-gateway-id="${escapeHtml(gateway.id)}">检测连接</button>
        <button class="drawer-action" type="button" data-drawer-action="toggle-gateway" data-gateway-id="${escapeHtml(gateway.id)}">${gateway.enabled ? "停用渠道" : "启用渠道"}</button>
        <button class="drawer-action" type="button" data-drawer-action="reset-gateway" data-gateway-id="${escapeHtml(gateway.id)}" ${draftState.anyDirty ? "" : "disabled"}>还原修改</button>
        <button class="drawer-action danger" type="button" data-drawer-action="delete-gateway" data-gateway-id="${escapeHtml(gateway.id)}">删除渠道</button>
      </div>
    </div>
    <div class="detail-section">
      <h3>运行状态</h3>
      ${fieldRow("渠道 ID", gateway.id)}
      ${fieldRow("状态", gateway.enabled ? "启用" : "停用")}
      ${fieldRow("健康", statusLabel(healthValue))}
      ${fieldRow("最近延迟", formatLatency(gateway.lastLatencyMs))}
      ${fieldRow("最近检测", formatDate(gateway.lastCheckedAt))}
      ${fieldRow("错误", gateway.lastError || "-")}
    </div>
    <div class="detail-section">
      <h3>调度参数</h3>
      ${fieldRow("优先级", gateway.priority)}
      ${fieldRow("超时", `${gateway.timeoutMs || 0} ms`)}
      ${fieldRow("冷却到", formatDate(gateway.disabledUntil))}
    </div>
  `);
}

function showUserDetail(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  const jobs = state.jobs.filter((job) => job.userId === user.id);
  const spent = jobs.reduce((sum, job) => sum + Number(job.costCredits || 0), 0);
  openDrawer(user.email, user.name || user.id, `
    <div class="detail-section">
      <h3>账号</h3>
      ${fieldRow("用户 ID", user.id)}
      ${fieldRow("积分余额", Number(user.credits || 0))}
      ${fieldRow("创建时间", formatDate(user.createdAt))}
      ${fieldRow("更新时间", formatDate(user.updatedAt))}
    </div>
    <div class="detail-section">
      <h3>调用资产</h3>
      ${fieldRow("任务数量", jobs.length)}
      ${fieldRow("积分消耗", spent)}
    </div>
    <div class="detail-section">
      <h3>积分调整</h3>
      <div class="drawer-credit-form">
        <label>调整值<input id="drawerCreditAmount" type="number" placeholder="+100 / -20" /></label>
        <label>原因<input id="drawerCreditReason" placeholder="调整原因" /></label>
        <div class="drawer-credit-actions">
          <button class="primary" id="drawerCreditSubmit" type="button" data-user-id="${escapeHtml(user.id)}">确认调额</button>
        </div>
      </div>
    </div>
  `);
}

function showJobDetail(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  const resultUrl = adminJobResultUrl(job);
  openDrawer(job.model || "绘图任务", job.id, `
    ${resultUrl ? `<a class="drawer-result" href="${escapeHtml(resultUrl)}" target="_blank" rel="noreferrer">打开生成结果</a>` : ""}
    ${resultUrl ? `
      <div class="detail-section">
        <h3>结果预览</h3>
        <div class="drawer-preview-card">
          <img class="drawer-preview" src="${escapeHtml(resultUrl)}" alt="任务结果预览" loading="lazy" />
        </div>
      </div>
    ` : ""}
    <div class="detail-section">
      <h3>任务</h3>
      ${fieldRow("状态", statusLabel(job.status))}
      ${fieldRow("用户", job.userEmail || job.userId)}
      ${fieldRow("模型", job.model)}
      ${fieldRow("渠道", job.gatewayId || "-")}
      ${fieldRow("比例", job.ratio || "-")}
      ${fieldRow("质量", job.quality || "-")}
      ${fieldRow("积分", Number(job.costCredits || 0))}
      ${fieldRow("创建时间", formatDate(job.createdAt))}
      ${fieldRow("完成时间", formatDate(job.completedAt))}
      ${fieldRow("错误", job.errorMessage || "-")}
    </div>
    <div class="detail-section">
      <h3>提示词</h3>
      <p class="prompt-box">${escapeHtml(job.prompt || "-")}</p>
    </div>
  `);
}

function showAuditDetail(id) {
  const log = state.logs.find((item) => item.id === id);
  if (!log) return;
  openDrawer(log.action, formatDate(log.createdAt), `
    <div class="detail-section">
      <h3>审计记录</h3>
      ${fieldRow("操作者", log.actorEmail || log.actorId)}
      ${fieldRow("动作", log.action)}
      ${fieldRow("目标", log.targetId)}
      ${fieldRow("时间", formatDate(log.createdAt))}
    </div>
    <div class="detail-section">
      <h3>元数据</h3>
      ${jsonBlock(log.meta)}
    </div>
  `);
}

function rowPatch(row) {
  const patch = {};
  $$("[data-field]", row).forEach((input) => {
    const key = input.dataset.field;
    patch[key] = input.type === "number" ? Number(input.value) : input.value;
  });
  if (patch.enabled !== undefined) patch.enabled = patch.enabled === "true";
  if (patch.apiKey && /^[*•]+$/.test(String(patch.apiKey))) delete patch.apiKey;
  ["healthCheckPath", "generationPath", "upstreamGroup"].forEach((key) => {
    if (patch[key] !== undefined) patch[key] = String(patch[key] || "").trim();
  });
  return patch;
}

function validateGatewayPayload(payload) {
  const apiKey = String(payload.apiKey || "").trim();
  const baseUrl = String(payload.baseUrl || "").trim();
  if (apiKey && /^https?:\/\//i.test(apiKey)) {
    throw new Error("API Key 不能填写 URL：Base URL 填 https://...，API Key 填 sk-...");
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Base URL 必须是 https://... 或 http://... 地址");
  }
}

function gatewayTestMessage(response) {
  if (response.ok) return `测试成功 · ${formatLatency(response.latencyMs)}`;
  return `测试失败${response.error ? `：${response.error}` : ""}`;
}

function syncSelection(type, visibleIds, selectAllId, barId, countId, emptyLabel) {
  const selected = state.selected[type];
  const selectedCount = selected.size;
  const selectAll = $(selectAllId);
  selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  selectAll.indeterminate = visibleIds.some((id) => selected.has(id)) && !selectAll.checked;
  $(barId).classList.toggle("hidden", selectedCount === 0);
  $(countId).textContent = selectedCount ? `已选择 ${selectedCount} 个${type === "gateways" ? "渠道" : "用户"}` : emptyLabel;
}

function clearSelection(type) {
  state.selected[type].clear();
  renderAll();
}

function setVisibleSelection(type, ids, checked) {
  ids.forEach((id) => {
    if (checked) state.selected[type].add(id);
    else state.selected[type].delete(id);
  });
  renderAll();
}

async function patchMany(items, runner, message, afterEach = null) {
  if (!items.length) throw new Error("请先选择数据");
  for (const item of items) {
    const result = await runner(item);
    if (afterEach) afterEach(result, item);
  }
  rerenderAfterMutation();
  toast(message, "success");
}

function renderQuickActions(view) {
  const container = $("quickActions");
  if (!container) return;
  container.innerHTML = (quickActions[view] || []).map(([id, label, action, target, tone]) => (
    `<button class="${tone || ""}" data-quick="${escapeHtml(action)}" data-target="${escapeHtml(target)}" type="button">${escapeHtml(label)}</button>`
  )).join("");
}

function switchView(view) {
  const nextView = titles[view] ? view : "channels";
  state.view = nextView;
  localStorage.setItem(STORAGE_KEYS.view, nextView);
  closeDrawer();
  $$("#nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === nextView));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === nextView));
  $("viewTitle").textContent = titles[nextView][0];
  $("viewSubtitle").textContent = titles[nextView][1];
  const activeTab = $("activeTab");
  if (activeTab) activeTab.textContent = titles[nextView][0];
  renderQuickActions(nextView);
  const searchId = searchTargets[nextView];
  $("globalSearch").value = searchId ? $(searchId).value : "";
  $("globalSearch").placeholder = searchId ? `搜索${titles[nextView][0]}` : "搜索当前页面";
  if (nextView === "system") loadSystem().catch((error) => toast(error.message, "error"));
  if (nextView === "settings") loadSiteSettings();
}

function renderSystemCards(ready, metrics) {
  const metricLines = String(metrics || "").split("\n").filter((line) => line && !line.startsWith("#")).length;
  $("systemCards").innerHTML = [
    statCard("Redis", ready.redis ? "正常" : "未启用", ready.redis ? "分布式能力已连接" : "当前为单机内存队列"),
    statCard("网关并发", `${ready.gateway?.active || 0}/${ready.gateway?.concurrency || 0}`, ready.gateway?.distributed ? "Redis 分布式锁" : "本地限流"),
    statCard("任务队列", ready.queue?.mode || "-", `${ready.queue?.processed || 0} 已处理 · ${ready.queue?.failed || 0} 失败`),
    statCard("启动恢复", ready.queue?.recovered || 0, ready.queue?.lastRecoveredAt ? formatRelative(ready.queue.lastRecoveredAt) : "无待恢复任务"),
    statCard("等待队列", ready.gateway?.queued || 0, "本机 limiter 队列"),
    statCard("指标项", metricLines, "Prometheus 文本行"),
  ].join("");
}

async function loadSystem() {
  const [ready, metrics] = await Promise.all([
    api("/api/ready"),
    fetch("/api/metrics", { credentials: "same-origin" }).then((res) => res.text()),
  ]);
  state.ready = ready;
  renderRuntime(ready);
  renderSystemCards(ready, metrics);
  $("readyJson").textContent = JSON.stringify(ready, null, 2);
  $("metricsText").textContent = metrics;
}

function bindFilter(id, render) {
  $(id).addEventListener("input", render);
  $(id).addEventListener("change", render);
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginMessage").textContent = "";
  try {
    await withBusy(event.submitter, "登录中", async () => {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: $("loginEmail").value.trim(), password: $("loginPassword").value }),
      });
      await ensureAdmin();
    });
  } catch (error) {
    $("loginMessage").textContent = error.message;
  }
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    state.user = null;
    stopAutoRefresh();
    resetTransientUi();
    clearAdminData();
    setAdminVisible(false);
  }
});

$("refreshButton").addEventListener("click", async () => {
  try {
    await withBusy($("refreshButton"), "刷新中", loadAll);
    toast("已刷新", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("autoRefreshButton").addEventListener("click", () => {
  state.autoRefresh = !state.autoRefresh;
  localStorage.setItem(STORAGE_KEYS.autoRefresh, state.autoRefresh ? "on" : "off");
  applyAutoRefresh();
});

$("globalSearch").addEventListener("input", (event) => {
  const view = activeView();
  const targetId = searchTargets[view];
  if (!targetId) return;
  $(targetId).value = event.target.value;
  renderers[view]();
});

$("nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) switchView(button.dataset.view);
});

document.querySelector(".menu-button")?.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? "1" : "0");
  applyShellState();
});

document.addEventListener("click", async (event) => {
  const jump = event.target.closest("[data-view-jump]");
  if (jump) switchView(jump.dataset.viewJump);
  const quick = event.target.closest("[data-quick]");
  if (quick) {
    const action = quick.dataset.quick;
    const target = quick.dataset.target || "";
    if (action === "view") switchView(target);
    if (action === "open") {
      const box = $(target);
      if (box) { box.open = true; box.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
    }
    if (action === "click") $(target)?.click();
    if (action === "bulk") document.querySelector(`[data-bulk=\"${target}\"]`)?.click();
    if (action === "filter") {
      const [id, value] = target.split(":");
      if ($(id)) { $(id).value = value; $(id).dispatchEvent(new Event("change")); }
    }
    if (action === "reload") $("refreshButton")?.click();
    if (action === "link") window.open(target, "_blank", "noopener");
  }
  const detailTarget = event.target.closest("[data-open-detail]");
  if (detailTarget) {
    const type = detailTarget.dataset.openDetail;
    const id = detailTarget.dataset.id;
    if (type === "gateway") showGatewayDetail(id);
    if (type === "job") showJobDetail(id);
  }
  if (event.target.closest("[data-action='reload']")) {
    const button = event.target.closest("[data-action='reload']");
    try {
      await withBusy(button, "刷新中", loadAll);
      toast("已刷新", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }
});

$("closeDrawer").addEventListener("click", closeDrawer);
$("drawerScrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
  if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
    const active = document.activeElement;
    const editing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
    if (!editing) {
      event.preventDefault();
      $("globalSearch").focus();
      $("globalSearch").select();
    }
  }
});

$("gatewayForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  try {
    await withBusy(button, "创建中", async () => {
      const data = formData(form);
      ["healthCheckPath", "generationPath", "upstreamGroup"].forEach((field) => {
        data[field] = String(data[field] || "").trim();
      });
      data.costCredits = Number(data.costCredits || 0);
      data.timeoutMs = Number(data.timeoutMs || 0);
      data.priority = Number(data.priority || 0);
      data.enabled = data.enabled === "true";
      validateGatewayPayload(data);
      await api("/api/admin/gateways", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadAll();
    });
    toast("渠道已创建", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("gatewayRows").addEventListener("change", (event) => {
  const field = event.target.closest("[data-field]");
  if (field) {
    captureRowDraft("gateways", field);
    return;
  }
  const checkbox = event.target.closest("[data-select='gateway']");
  if (!checkbox) return;
  const id = checkbox.closest("tr").dataset.id;
  if (checkbox.checked) state.selected.gateways.add(id);
  else state.selected.gateways.delete(id);
  renderGateways();
});

$("gatewayRows").addEventListener("input", (event) => {
  const field = event.target.closest("[data-field]");
  if (!field) return;
  captureRowDraft("gateways", field);
});

$("gatewaySelectAll").addEventListener("change", (event) => {
  setVisibleSelection("gateways", filteredGateways().map((item) => item.id), event.target.checked);
});

$("gatewayRows").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  try {
    const row = button.closest("tr");
    if (button.dataset.action === "gateway-menu") {
      showGatewayMenu(row.dataset.id);
      return;
    }
    if (button.dataset.action === "toggle-gateway") {
      const gateway = state.gateways.find((item) => item.id === row.dataset.id);
      const currentValue = rowInputValue("gateways", row.dataset.id, "enabled", gateway) === "true";
      setRowDraftField("gateways", row.dataset.id, "enabled", currentValue ? "false" : "true");
      renderGateways();
      return;
    }
    if (button.dataset.action === "reset-gateway") {
      clearRowDraft("gateways", row.dataset.id);
      renderGateways();
      return;
    }
    if (button.dataset.action === "save-gateway") {
      const patch = rowPatch(row);
      validateGatewayPayload(patch);
      const { gateway } = await withBusy(button, "保存中", () => api(`/api/admin/gateways/${row.dataset.id}`, { method: "PATCH", body: JSON.stringify(patch) }));
      upsertById(state.gateways, gateway);
      clearRowDraft("gateways", row.dataset.id);
      appendAuditLog("gateway.update", row.dataset.id, patch);
      rerenderAfterMutation();
      toast("渠道已保存", "success");
      return;
    }
    if (button.dataset.action === "check-gateway") {
      const response = await withBusy(button, "检测中", () => api(`/api/admin/gateways/${row.dataset.id}/health-check`, { method: "POST" }));
      upsertById(state.gateways, response.gateway);
      appendAuditLog("gateway.health_check", row.dataset.id, { ok: response.ok, latencyMs: response.latencyMs, error: response.error || null });
      rerenderAfterMutation();
      toast(gatewayTestMessage(response), response.ok ? "success" : "error");
      return;
    }
    if (button.dataset.action === "detail-gateway") {
      showGatewayDetail(row.dataset.id);
      return;
    }
    if (button.dataset.action === "delete-gateway") {
      await withBusy(button, "删除中", () => api(`/api/admin/gateways/${row.dataset.id}`, { method: "DELETE" }));
      state.gateways = state.gateways.filter((item) => item.id !== row.dataset.id);
      appendAuditLog("gateway.delete", row.dataset.id, {});
      rerenderAfterMutation();
      toast("渠道已删除", "success");
      return;
    }
  } catch (error) {
    toast(error.message, "error");
    await loadAll().catch(() => {});
  }
});

$("userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  try {
    await withBusy(button, "创建中", async () => {
      const data = formData(form);
      data.credits = Number(data.credits || 0);
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      await loadAll();
    });
    toast("用户已创建", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("checkAllGateways").addEventListener("click", async () => {
  try {
    await withBusy($("checkAllGateways"), "检测中", async () => {
      const response = await api("/api/admin/gateways/health-check", { method: "POST" });
      state.gateways = response.results.map((item) => item.gateway);
      appendAuditLog("gateway.health_check_all", "gateways", { total: response.results.length, ok: response.results.filter((item) => item.ok).length });
      rerenderAfterMutation();
      const okCount = response.results.filter((item) => item.ok).length;
      const failedCount = response.results.length - okCount;
      toast(failedCount ? `测试完成 · 成功 ${okCount} 个，失败 ${failedCount} 个` : `测试成功 · ${okCount} 个渠道可用`, failedCount ? "error" : "success");
    });
  } catch (error) {
    toast(error.message, "error");
    await loadAll().catch(() => {});
  }
});

$("userRows").addEventListener("change", (event) => {
  const field = event.target.closest("[data-field]");
  if (field) {
    captureRowDraft("users", field);
    return;
  }
  const checkbox = event.target.closest("[data-select='user']");
  if (!checkbox) return;
  const id = checkbox.closest("tr").dataset.id;
  if (checkbox.checked) state.selected.users.add(id);
  else state.selected.users.delete(id);
  renderUsers();
});

$("userRows").addEventListener("input", (event) => {
  const field = event.target.closest("[data-field]");
  if (!field) return;
  captureRowDraft("users", field);
});

$("userSelectAll").addEventListener("change", (event) => {
  setVisibleSelection("users", filteredUsers().map((item) => item.id), event.target.checked);
});

$("userRows").addEventListener("click", async (event) => {
  const row = event.target.closest("tr");
  const action = event.target.closest("button")?.dataset.action;
  if (!row || !action) return;
  try {
    if (action === "user-menu") {
      const user = state.users.find((item) => item.id === row.dataset.id);
      if (!user) return;
      openDrawer(user.email, user.name || user.id, `
        <div class="detail-section">
          <h3>快捷操作</h3>
          <div class="drawer-action-list">
            <button class="drawer-action" type="button" data-drawer-action="detail-user" data-user-id="${escapeHtml(user.id)}">查看详情</button>
            <button class="drawer-action" type="button" data-drawer-action="credit-user" data-user-id="${escapeHtml(user.id)}">调整积分</button>
          </div>
        </div>
      `);
      return;
    }
    if (action === "detail-user") {
      showUserDetail(row.dataset.id);
      return;
    }
    if (action === "save-user") {
      return;
    }
    if (action === "reset-user") {
      clearRowDraft("users", row.dataset.id);
      renderUsers();
      return;
    }
  } catch (error) {
    toast(error.message, "error");
  }
});

$("drawerBody").addEventListener("click", async (event) => {
  const drawerButton = event.target.closest("[data-drawer-action], #drawerCreditSubmit");
  if (!drawerButton) return;
  try {
    const gatewayId = drawerButton.dataset.gatewayId;
    if (gatewayId) {
      if (drawerButton.dataset.drawerAction === "detail-gateway") {
        showGatewayDetail(gatewayId);
        return;
      }
      if (drawerButton.dataset.drawerAction === "check-gateway") {
        const response = await withBusy(drawerButton, "检测中", () => api(`/api/admin/gateways/${gatewayId}/health-check`, { method: "POST" }));
        upsertById(state.gateways, response.gateway);
        appendAuditLog("gateway.health_check", gatewayId, { ok: response.ok, latencyMs: response.latencyMs, error: response.error || null });
        rerenderAfterMutation();
        toast(gatewayTestMessage(response), response.ok ? "success" : "error");
        showGatewayMenu(gatewayId);
        return;
      }
      if (drawerButton.dataset.drawerAction === "toggle-gateway") {
        const gateway = state.gateways.find((item) => item.id === gatewayId);
        if (!gateway) return;
        const { gateway: nextGateway } = await withBusy(drawerButton, gateway.enabled ? "停用中" : "启用中", () => api(`/api/admin/gateways/${gatewayId}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !gateway.enabled }),
        }));
        upsertById(state.gateways, nextGateway);
        clearRowDraft("gateways", gatewayId, ["enabled"]);
        appendAuditLog("gateway.update", gatewayId, { enabled: nextGateway.enabled });
        rerenderAfterMutation();
        toast(nextGateway.enabled ? "渠道已启用" : "渠道已停用", "success");
        showGatewayMenu(gatewayId);
        return;
      }
      if (drawerButton.dataset.drawerAction === "reset-gateway") {
        clearRowDraft("gateways", gatewayId);
        renderGateways();
        showGatewayMenu(gatewayId);
        return;
      }
      if (drawerButton.dataset.drawerAction === "delete-gateway") {
        await withBusy(drawerButton, "删除中", () => api(`/api/admin/gateways/${gatewayId}`, { method: "DELETE" }));
        state.gateways = state.gateways.filter((item) => item.id !== gatewayId);
        clearRowDraft("gateways", gatewayId);
        appendAuditLog("gateway.delete", gatewayId, {});
        rerenderAfterMutation();
        closeDrawer();
        toast("渠道已删除", "success");
        return;
      }
    }

    if (drawerButton.id === "drawerCreditSubmit") {
      const userId = drawerButton.dataset.userId;
      const amount = Number($("drawerCreditAmount")?.value || 0);
      const reason = $("drawerCreditReason")?.value || "admin_adjust";
      if (!Number.isFinite(amount) || amount === 0) throw new Error("请输入非 0 积分调整值");
      const { user } = await withBusy(drawerButton, "提交中", () => api("/api/admin/credits", {
        method: "POST",
        body: JSON.stringify({ userId, amount, reason }),
      }));
      upsertById(state.users, user);
      adjustSummaryForCreditChange(amount);
      appendAuditLog("credits.change", userId, { amount, reason });
      rerenderAfterMutation();
      toast("积分已调整", "success");
      closeDrawer();
      return;
    }

    const action = drawerButton.dataset.drawerAction;
    const userId = drawerButton.dataset.userId;
    if (!userId) return;

    if (action === "detail-user") {
      showUserDetail(userId);
      return;
    }

    if (action === "credit-user") {
      showUserDetail(userId);
      return;
    }

    if (action === "detail-job") {
      const jobId = drawerButton.dataset.jobId;
      if (jobId) showJobDetail(jobId);
      return;
    }

  } catch (error) {
    toast(error.message, "error");
  }
});

$("jobRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr");
  if (!row) return;
  const job = state.jobs.find((item) => item.id === row.dataset.id);
  if (!job) return;
  if (button.dataset.action === "detail-job") {
    showJobDetail(job.id);
    return;
  }
  if (button.dataset.action === "job-menu") {
    openDrawer(job.model || "绘图任务", job.userEmail || job.id, `
      <div class="detail-section">
        <h3>快捷操作</h3>
        <div class="drawer-action-list">
          <button class="drawer-action" type="button" data-drawer-action="detail-job" data-job-id="${escapeHtml(job.id)}">查看详情</button>
          ${job.resultUrl ? `<a class="drawer-action" href="${escapeHtml(adminJobResultUrl(job))}" target="_blank" rel="noreferrer">打开结果</a>` : ""}
          <div class="drawer-helper">任务编号：${escapeHtml(job.id)}</div>
        </div>
      </div>
    `);
  }
});

$("auditRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='detail-audit']");
  if (!button) return;
  showAuditDetail(button.closest("tr").dataset.id);
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-bulk]");
  if (!button) return;
  try {
    const action = button.dataset.bulk;
    if (action === "gateway-clear") return clearSelection("gateways");
    if (action === "gateway-enable" || action === "gateway-disable") {
      const enabled = action === "gateway-enable";
      const gateways = [...state.selected.gateways];
      await withBusy(button, "处理中", () => patchMany(
        gateways,
        (id) => api(`/api/admin/gateways/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
        "渠道状态已批量更新",
        (result, id) => {
          upsertById(state.gateways, result.gateway);
          appendAuditLog("gateway.update", id, { enabled });
        },
      ));
      state.selected.gateways.clear();
    }
    if (action === "gateway-delete") {
      const gateways = [...state.selected.gateways];
      await withBusy(button, "删除中", () => patchMany(
        gateways,
        (id) => api(`/api/admin/gateways/${id}`, { method: "DELETE" }),
        "渠道已批量删除",
        (_, id) => {
          state.gateways = state.gateways.filter((item) => item.id !== id);
          appendAuditLog("gateway.delete", id, {});
        },
      ));
      state.selected.gateways.clear();
    }

    if (action === "user-clear") return clearSelection("users");
    if (action === "user-credit") {
      const amount = Number($("bulkCreditAmount").value);
      if (!Number.isFinite(amount) || amount === 0) throw new Error("请输入非 0 批量积分");
      const reason = $("bulkCreditReason").value.trim() || "bulk_admin_adjust";
      const users = [...state.selected.users];
      await withBusy(button, "处理中", () => patchMany(
        users,
        (id) => api("/api/admin/credits", { method: "POST", body: JSON.stringify({ userId: id, amount, reason }) }),
        "积分已批量调整",
        (result, id) => {
          upsertById(state.users, result.user);
          adjustSummaryForCreditChange(amount);
          appendAuditLog("credits.change", id, { amount, reason });
        },
      ));
      state.selected.users.clear();
      $("bulkCreditAmount").value = "";
      $("bulkCreditReason").value = "";
    }

  } catch (error) {
    toast(error.message, "error");
  }
});

$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  try {
    await withBusy(button, "创建中", async () => {
      const data = formData(form);
      data.credits = Number(data.credits || 0);
      data.maxUses = Number(data.maxUses || 0);
      data.expiresAt = isoFromLocal(data.expiresAt);
      const { code } = await api("/api/admin/redemption-codes", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      state.codes.unshift(code);
      appendAuditLog("redemption_code.create", code.id, { code: code.code, activityKey: code.activityKey, credits: code.credits, maxUses: code.maxUses });
      rerenderAfterMutation();
    });
    toast("兑换码已创建", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("codeRows").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action='toggle-code']");
  if (!button) return;
  try {
    const id = button.closest("tr").dataset.id;
    const code = state.codes.find((item) => item.id === id);
    const nextActive = !code.active;
    const response = await withBusy(button, "更新中", () => api(`/api/admin/redemption-codes/${id}`, { method: "PATCH", body: JSON.stringify({ active: nextActive }) }));
    upsertById(state.codes, response.code);
    appendAuditLog("redemption_code.update", id, { active: nextActive });
    rerenderAfterMutation();
    toast("兑换码状态已更新", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("reloadSystem").addEventListener("click", () => loadSystem().catch((error) => toast(error.message, "error")));

async function loadSiteSettings() {
  try {
    const s = await api("/api/admin/settings");
    $("buyCreditsUrl").value = s.buy_credits_url || "";
  } catch (error) {
    toast(error.message, "error");
  }
}

$("siteSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ buy_credits_url: $("buyCreditsUrl").value.trim() }) });
    toast("设置已保存", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAutoRefresh();
  else applyAutoRefresh();
});

window.addEventListener("beforeunload", (event) => {
  if (!hasDirtyDrafts()) return;
  event.preventDefault();
  event.returnValue = "";
});

bindFilter("gatewaySearch", renderGateways);
bindFilter("gatewayStatusFilter", renderGateways);
bindFilter("gatewayProviderFilter", renderGateways);
bindFilter("userSearch", renderUsers);
bindFilter("jobSearch", renderJobs);
bindFilter("jobStatusFilter", renderJobs);
bindFilter("codeSearch", renderCodes);
bindFilter("codeStatusFilter", renderCodes);
bindFilter("auditSearch", renderAudit);

applyDensity();
applyShellState();
applyAutoRefresh();
switchView(state.view);
ensureAdmin();
