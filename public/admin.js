const STORAGE_KEYS = {
  density: "admin-density",
  view: "admin-active-view",
  sidebarCollapsed: "admin-sidebar-collapsed",
  autoRefresh: "admin-auto-refresh",
  successRateScope: "admin-success-rate-scope",
};

const DEFAULT_CALL_SQUARE_CONFIG = {
  url: "https://api.superapi.me/v1/images/generations",
  apiKey: "",
  upstreamGroup: "",
  requestBody: `{
  "model": "gpt-image-2",
  "prompt": "一张用于渠道测试的产品海报，干净背景，细节清晰",
  "size": "1024x1024",
  "quality": "low",
  "format": "png"
}`,
  timeoutMs: 90000,
  apiKeyConfigured: false,
};

const AUTO_REFRESH_MS = 30000;
const DEFAULT_USER_WARNING_MESSAGE = "系统检测到你的账号可能存在涉嫌欺诈或其他涉嫌违法违规的行为。请立即停止相关操作并遵守平台规则；如再次或多次出现类似行为，平台将封禁账号。";
const MAX_CALL_SQUARE_TIMEOUT_MS = 1200000;

const state = {
  user: null,
  summary: null,
  usage: null,
  usageDays: 14,
  ready: null,
  users: [],
  gateways: [],
  codes: [],
  jobs: [],
  gallery: {
    images: [],
    limit: 500,
    offset: 0,
    total: 0,
    maxItems: 3000,
    page: 0,
    pageCount: 0,
  },
  logs: [],
  sensitiveRules: [],
  riskAlerts: [],
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
  successRateScope: localStorage.getItem(STORAGE_KEYS.successRateScope) || "24h",
  sidebarCollapsed: localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === "1",
  autoRefresh: localStorage.getItem(STORAGE_KEYS.autoRefresh) !== "off",
  refreshTimer: null,
  loadingAll: false,
  lastLoadPromise: null,
  lastCreatedCodes: [],
  callSquareConfig: { ...DEFAULT_CALL_SQUARE_CONFIG },
  callSquareConfigLoaded: false,
  callSquareReferenceFiles: [],
  callSquareReferenceUrls: [],
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
  "call-square": ["调用广场", "保存并测试上游 URL、API Key 和模型"],
  users: ["用户", "账号状态与积分"],
  jobs: ["任务", "最近 100 条绘图请求"],
  gallery: ["作品看板", "最近 3000 张生成图片"],
  risk: ["敏感词风控", "正则规则、拦截记录和用户告警"],
  codes: ["兑换码", "积分兑换和活动发放"],
  audit: ["审计", "最近 100 条操作记录"],
  system: ["系统", "运行探针、指标和 OpenAPI"],
  settings: ["站点设置", "前台展示与跳转配置"],
};

const searchTargets = {
  channels: "gatewaySearch",
  users: "userSearch",
  jobs: "jobSearch",
  gallery: "gallerySearch",
  risk: "riskSearch",
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
  gallery: renderGallery,
  risk: renderRisk,
  codes: renderCodes,
  audit: renderAudit,
};

const quickActions = {
  overview: [
    ["channels", "渠道配置", "view", "channels"],
    ["call-square", "渠道测试", "view", "call-square", "primary"],
    ["jobs", "查看绘图任务", "view", "jobs"],
  ],
  channels: [
    ["call-square", "调用广场", "view", "call-square", "primary"],
    ["gateway-check", "检测全部渠道", "click", "checkAllGateways", "green"],
    ["gateway-enable-healthy", "一键启用熔断渠道", "click", "enableHealthyGateways", "primary"],
    ["gateway-create", "新增中转站", "open", "gatewayCreateBox", "primary"],
    ["jobs", "查看任务队列", "view", "jobs"],
  ],
  "call-square": [
    ["call-square-test", "生成测试", "click", "callSquareSubmit", "primary"],
    ["channels", "渠道清单", "view", "channels"],
    ["system", "系统探针", "view", "system"],
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
  gallery: [
    ["gallery-refresh", "刷新看板", "click", "galleryReloadButton", "primary"],
    ["gallery-success", "只看成功", "filter", "galleryStatusFilter:succeeded", "green"],
    ["jobs", "查看任务", "view", "jobs"],
  ],
  risk: [
    ["risk-import", "批量导入规则", "focus", "sensitiveWordPatterns", "primary"],
    ["risk-alerts", "查看最新告警", "focus", "riskSearch"],
    ["audit", "查看审计", "view", "audit"],
  ],
  codes: [
    ["code-create", "创建兑换码", "open", "codeCreateBox", "primary"],
    ["code-copy", "复制当前列表", "click", "copyFilteredCodes", "green"],
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

class ApiError extends Error {
  constructor(message, status, payload, responseText) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload || {};
    this.responseText = responseText || "";
  }
}

async function api(path, options = {}) {
  const headers = options.body instanceof FormData
    ? { ...(options.headers || {}) }
    : { "Content-Type": "application/json", ...(options.headers || {}) };
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const responseText = await response.text().catch(() => "");
  let payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const message = payload.message || payload.error || response.statusText || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, payload, responseText);
  }
  return payload;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function copyText(text) {
  if (!text) throw new Error("没有可复制的内容");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
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

function jobTotalLatency(job) {
  return job?.totalLatencyMs ?? job?.currentLatencyMs ?? job?.latencyMs ?? null;
}

function jobTimingReason(job) {
  return job?.timingReason || job?.timing?.reason || "-";
}

function jobBottleneckLabel(value) {
  return {
    queue: "排队",
    upstream: "上游",
    gateway: "渠道",
    storage: "存储",
    timeout: "超时",
    retry: "重试",
    unknown: "未知",
  }[String(value || "unknown")] || String(value || "-");
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function timingCell(job) {
  const total = jobTotalLatency(job);
  const queue = job.queueLatencyMs ?? job.timing?.queueMs;
  const processing = job.processingLatencyMs ?? job.timing?.processingMs;
  const bottleneck = job.timingBottleneck || job.timing?.bottleneck || "unknown";
  return `
    <div class="cell-stack timing-cell" title="${escapeHtml(jobTimingReason(job))}">
      <strong>${escapeHtml(formatLatency(total))}</strong>
      <small>${escapeHtml(jobBottleneckLabel(bottleneck))} · 队列 ${escapeHtml(formatLatency(queue))} · 处理 ${escapeHtml(formatLatency(processing))}</small>
    </div>
  `;
}

function adminJobResultUrl(job) {
  if (!job?.resultUrl) return "";
  return job.resultUrl;
}

function galleryImageUrl(item) {
  return item?.thumbnailUrl || item?.url || "";
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
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  button.textContent = mobile ? "☰" : (state.sidebarCollapsed ? "→" : "☰");
  button.setAttribute("aria-label", state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏");
  button.setAttribute("title", state.sidebarCollapsed ? "展开侧边栏" : "收起侧边栏");
}

function setMobileNavOpen(open) {
  document.body.classList.toggle("mobile-nav-open", open);
  $("mobileNavScrim")?.classList.toggle("hidden", !open);
}

function syncMobileDock(view = activeView()) {
  $$("#mobileDock [data-mobile-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileView === view);
  });
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
  state.gallery = { images: [], limit: 500, offset: 0, total: 0, maxItems: 3000, page: 0, pageCount: 0 };
  state.logs = [];
  state.sensitiveRules = [];
  state.riskAlerts = [];
  state.selected.gateways.clear();
  state.selected.users.clear();
  state.drafts.gateways = {};
  state.drafts.users = {};
  state.callSquareConfig = { ...DEFAULT_CALL_SQUARE_CONFIG };
  state.callSquareConfigLoaded = false;
  applyCallSquareConfig(state.callSquareConfig);
  $("adminIdentity").textContent = "未登录";
  $("sideHealth").textContent = "未连接";
  $("sideHealthMeta").textContent = "等待检查";
  $("lastRefresh").textContent = "未刷新";
  [
    "navOverviewCount",
    "navChannelCount",
    "navUserCount",
    "navJobCount",
    "navRiskCount",
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
    if (activeView() === "gallery") await loadGallery();
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
      const [summary, usage, users, gateways, codes, jobs, logs, sensitiveRules, riskAlerts, ready] = await Promise.all([
        api("/api/admin/summary"),
        api("/api/admin/usage?days=" + state.usageDays),
        api("/api/admin/users"),
        api("/api/admin/gateways"),
        api("/api/admin/redemption-codes"),
        api("/api/admin/jobs"),
        api("/api/admin/audit-logs"),
        api("/api/admin/sensitive-words"),
        api("/api/admin/risk-alerts"),
        api("/api/ready"),
      ]);
      state.summary = summary;
      state.usage = usage;
      state.users = users.users;
      state.gateways = gateways.gateways;
      state.codes = codes.codes;
      state.jobs = jobs.jobs;
      state.logs = logs.logs;
      state.sensitiveRules = sensitiveRules.rules;
      state.riskAlerts = riskAlerts.alerts;
      state.ready = ready;
      if (!state.callSquareConfigLoaded) {
        await loadCallSquareConfig().catch((error) => toast(error.message, "error"));
      }
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

async function loadGallery(options = {}) {
  if (options.reset) state.gallery.offset = 0;
  const limit = Math.min(Math.max(Number(state.gallery.limit || 500), 1), 500);
  const offset = Math.max(Number(state.gallery.offset || 0), 0);
  const payload = await api(`/api/admin/gallery?limit=${limit}&offset=${offset}`);
  state.gallery = {
    images: payload.images || [],
    limit: Number(payload.limit || limit),
    offset: Number(payload.offset || offset),
    total: Number(payload.total || 0),
    maxItems: Number(payload.maxItems || 3000),
    page: Number(payload.page || 0),
    pageCount: Number(payload.pageCount || 0),
  };
  renderGallery();
  renderNavCounts();
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
  renderGallery();
  renderRisk();
  renderCodes();
  renderAudit();
}

function renderNavCounts() {
  const activeGateways = state.gateways.filter((gateway) => gateway.enabled).length;
  const activeUsers = state.users.filter((user) => user.status === "active").length;
  const openJobs = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const activeCodes = state.codes.filter((code) => code.active).length;
  const openRiskAlerts = state.riskAlerts.filter((alert) => alert.status === "open").length;
  $("navOverviewCount").textContent = `${state.jobs.length}`;
  $("navChannelCount").textContent = `${activeGateways}/${state.gateways.length}`;
  $("navUserCount").textContent = `${activeUsers}/${state.users.length}`;
  $("navJobCount").textContent = openJobs ? `${openJobs} 待` : `${state.jobs.length}`;
  $("navGalleryCount").textContent = state.gallery.total ? `${state.gallery.total}` : "-";
  $("navRiskCount").textContent = openRiskAlerts ? `${openRiskAlerts} 告警` : `${state.sensitiveRules.filter((rule) => rule.enabled).length} 规则`;
  $("navCodeCount").textContent = `${activeCodes}/${state.codes.length}`;
  $("navAuditCount").textContent = `${state.logs.length}`;
  $("navSystemCount").textContent = state.ready?.redis ? "Redis" : "本地";
}

function renderOverview() {
  const summary = state.summary || {};
  const todayJobs = state.jobs.filter((job) => isWithin(job.createdAt, 24));
  const activeGateways = state.gateways.filter((gateway) => gateway.enabled).length;
  const successRates = summary.successRates || {};
  const scope = state.successRateScope === "all" ? "all" : "24h";
  const selectedRate = successRates[scope] || {};
  const completed = Number(selectedRate.completed || 0);
  const rate = Number(selectedRate.rate || 0);
  const scopeLabel = scope === "24h" ? "24h" : "迄今";
  const metrics = [
    ["用户", summary.users || 0, `${state.users.filter((user) => user.status === "active").length} 个正常账号`],
    ["可用渠道", `${activeGateways}/${state.gateways.length}`, "按优先级调度"],
    ["今日任务", todayJobs.length, "过去 24 小时"],
    ["成功率", `${rate}%`, `${scopeLabel} · ${completed} 个已完成任务`, true],
    ["消耗积分", summary.creditSpent || 0, `累计发放 ${summary.creditIssued || 0}`],
    ["启用兑换码", state.codes.filter((code) => code.active).length, `${state.codes.length} 个库存`],
  ];
  $("metricGrid").innerHTML = metrics.map(([label, value, hint, isSuccessRate]) => `
    <div class="metric ${isSuccessRate ? "success-rate-metric" : ""}">
      <div class="metric-label-row">
        <span>${escapeHtml(label)}</span>
        ${isSuccessRate ? `
          <div class="metric-tabs" role="group" aria-label="成功率范围">
            <button class="${scope === "24h" ? "active" : ""}" data-success-rate-scope="24h" type="button">24h</button>
            <button class="${scope === "all" ? "active" : ""}" data-success-rate-scope="all" type="button">迄今</button>
          </div>
        ` : ""}
      </div>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(hint)}</small>
    </div>
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

let _usageChart = null;
let _modelChart = null;
let _gatewayChart = null;

const CHART_PALETTE = ["#63b3ed","#68d391","#f6ad55","#fc8181","#b794f4","#76e4f7","#fbd38d","#9ae6b4","#feb2b2","#e9d8fd"];

function renderUsage() {
  const usage = state.usage || { daily: [], byModel: [], byGateway: [], totals: {} };
  const totals = usage.totals || {};

  // stat row
  $("usageStatRow").innerHTML = [
    ["总任务", totals.jobs ?? 0],
    ["成功", totals.succeeded ?? 0],
    ["失败", totals.failed ?? 0],
    ["成功率", (totals.successRate ?? 0) + "%"],
    ["积分消耗", totals.credits ?? 0],
  ].map(([label, val]) => `<div class="usage-stat"><span>${label}</span><strong>${val}</strong></div>`).join("");

  $("usagePeriodLabel").textContent = `最近 ${state.usageDays} 天绘图任务、成功率和积分消耗`;

  // ── 图表1：任务趋势（柱状堆叠 + 积分折线）──
  const labels = usage.daily.map((d) => d.date.slice(5));
  const jobsData = usage.daily.map((d) => d.jobs);
  const succeededData = usage.daily.map((d) => d.succeeded);
  const failedData = usage.daily.map((d) => d.failed);
  const creditsData = usage.daily.map((d) => d.credits);

  if (_usageChart) { _usageChart.destroy(); _usageChart = null; }
  const canvas = $("usageChart");
  if (canvas) {
    _usageChart = new Chart(canvas, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "成功", data: succeededData, yAxisID: "y", backgroundColor: "rgba(99,179,237,0.8)", borderRadius: 3, order: 2 },
          { type: "bar", label: "失败", data: failedData, yAxisID: "y", backgroundColor: "rgba(252,129,74,0.8)", borderRadius: 3, order: 2 },
          { type: "line", label: "积分消耗", data: creditsData, yAxisID: "y2", borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,0.08)", borderWidth: 2, pointRadius: 3, tension: 0.35, fill: true, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterBody: (items) => {
                const i = items[0]?.dataIndex;
                if (i == null) return;
                const total = jobsData[i];
                const rate = total ? Math.round((succeededData[i] / total) * 100) : 0;
                return `总任务: ${total}  成功率: ${rate}%`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, stacked: true, ticks: { precision: 0, font: { size: 11 } }, title: { display: true, text: "任务数", font: { size: 11 } } },
          y2: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, ticks: { font: { size: 11 } }, title: { display: true, text: "积分", font: { size: 11 } } },
        },
      },
    });
  }

  // ── 图表2：模型调用分布（Doughnut）──
  if (_modelChart) { _modelChart.destroy(); _modelChart = null; }
  const modelCanvas = $("usageModelChart");
  const byModel = (usage.byModel || []).slice(0, 8);
  if (modelCanvas) {
    _modelChart = new Chart(modelCanvas, {
      type: "doughnut",
      data: {
        labels: byModel.map((m) => m.model),
        datasets: [{ data: byModel.map((m) => m.jobs), backgroundColor: CHART_PALETTE, borderWidth: 2, borderColor: "#fff", hoverOffset: 6 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } },
          title: { display: true, text: "模型调用分布", font: { size: 12, weight: "600" }, padding: { bottom: 8 } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed} 次` } },
        },
      },
    });
  }

  // ── 图表3：渠道成功率（水平条形）──
  if (_gatewayChart) { _gatewayChart.destroy(); _gatewayChart = null; }
  const gwCanvas = $("usageGatewayChart");
  const gatewayNames = new Map(state.gateways.map((g) => [g.id, g.name]));
  const byGateway = (usage.byGateway || []).slice(0, 6);
  if (gwCanvas) {
    const gwLabels = byGateway.map((g) => gatewayNames.get(g.gatewayId) || g.gatewayId);
    const gwSuccessRate = byGateway.map((g) => {
      const done = (g.succeeded ?? 0) + (g.failed ?? 0);
      return done ? Math.round(((g.succeeded ?? 0) / done) * 100) : null;
    });
    const gwJobs = byGateway.map((g) => g.jobs);
    _gatewayChart = new Chart(gwCanvas, {
      type: "bar",
      data: {
        labels: gwLabels,
        datasets: [
          { label: "成功率 %", data: gwSuccessRate, backgroundColor: gwSuccessRate.map((r) => r == null ? "#e2e8f0" : r >= 90 ? "rgba(104,211,145,0.8)" : r >= 70 ? "rgba(246,173,85,0.8)" : "rgba(252,129,74,0.8)"), borderRadius: 4, yAxisID: "y" },
          { label: "总调用", data: gwJobs, backgroundColor: "rgba(99,179,237,0.25)", borderColor: "rgba(99,179,237,0.6)", borderWidth: 1, borderRadius: 4, yAxisID: "y2", type: "bar" },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } },
          title: { display: true, text: "渠道成功率", font: { size: 12, weight: "600" }, padding: { bottom: 8 } },
          tooltip: { callbacks: { label: (ctx) => ctx.datasetIndex === 0 ? ` 成功率: ${ctx.parsed.x ?? "-"}%` : ` 总调用: ${ctx.parsed.x}` } },
        },
        scales: {
          x: { beginAtZero: true, max: 100, ticks: { font: { size: 11 }, callback: (v) => v + "%" }, grid: { display: false } },
          y: { ticks: { font: { size: 11 } }, grid: { display: false } },
          y2: { display: false, beginAtZero: true },
        },
      },
    });
  }
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
          <input class="num-input ${Object.prototype.hasOwnProperty.call(draftState.draft, "timeoutMs") ? "is-dirty" : ""}" data-field="timeoutMs" type="number" value="${escapeHtml(rowInputValue("gateways", gateway.id, "timeoutMs", gateway))}" placeholder="超时 ms" />
          <small>超时毫秒数</small>
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
  const pendingWarnings = state.users.reduce((sum, user) => sum + userWarnings(user).length, 0);
  $("userStats").innerHTML = [
    statCard("用户数", userCount, "当前账号总数"),
    statCard("低余额用户", state.users.filter((user) => Number(user.credits || 0) < 20).length, "需要补充积分"),
    statCard("积分余额", totalCredits, "所有用户合计"),
    statCard("待确认警告", pendingWarnings, "用户未关闭的风险提示"),
  ].join("");
}

function userWarnings(user) {
  return Array.isArray(user?.warnings) ? user.warnings : [];
}

function renderUsers() {
  renderUserStats();
  const rows = filteredUsers();

  $("userRows").innerHTML = rows.map((user) => {
    const draftState = getRowDraftState("users", user.id);
    const warningCount = userWarnings(user).length;
    return `
    <tr data-id="${user.id}" class="${draftState.anyDirty ? "is-dirty" : ""}">
      <td class="select-col"><input type="checkbox" data-select="user" ${state.selected.users.has(user.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(user.email)}" /></td>
      <td>
        <div class="cell-stack">
          <strong>${escapeHtml(user.email)}</strong>
          <small>${escapeHtml(user.name)}${warningCount ? ` · ${warningCount} 条待确认警告` : ""}</small>
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
  const returnedLatencies = state.jobs
    .filter((job) => job.status === "succeeded" || job.status === "success" || job.resultUrl || job.timing?.hasResult)
    .map((job) => job.totalLatencyMs ?? job.latencyMs)
    .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    .map(Number);
  const avgLatency = returnedLatencies.length
    ? Math.round(returnedLatencies.reduce((sum, value) => sum + value, 0) / returnedLatencies.length)
    : null;
  const p95Latency = percentile(returnedLatencies, 0.95);
  const bottlenecks = countBy(
    state.jobs.filter((job) => jobTimingReason(job) !== "-"),
    (job) => job.timingBottleneck || job.timing?.bottleneck || "unknown"
  );
  const topBottleneck = Object.entries(bottlenecks).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
  $("jobStats").innerHTML = [
    statCard("任务总数", state.jobs.length, "最近列表范围"),
    statCard("平均返回耗时", formatLatency(avgLatency), `P95 ${formatLatency(p95Latency)}`),
    statCard("主要慢点", jobBottleneckLabel(topBottleneck), `${bottlenecks[topBottleneck] || 0} 个任务`),
    statCard("今日提交", today, `${counts.failed || 0} 失败 · ${credits} 积分`),
  ].join("");
}

function renderJobs() {
  renderJobStats();
  const search = $("jobSearch").value;
  const status = $("jobStatusFilter").value;
  const rows = state.jobs
    .filter((job) => !status || job.status === status)
    .filter((job) => includesText(search, job.id, job.userEmail, job.userName, job.model, job.prompt, job.status, job.gatewayId, job.errorCode, job.errorMessage));

  $("jobRows").innerHTML = rows.map((job) => `
    <tr data-id="${job.id}">
      <td><div class="cell-stack"><strong>${escapeHtml(job.model || "image-task")}</strong><small>${escapeHtml(job.gatewayId || "")}</small></div></td>
      <td>${escapeHtml(job.userEmail || job.userId)}</td>
      <td>${escapeHtml(job.model)}</td>
      <td>${statusBadge(job.status)}${job.status === "failed" && job.errorCode ? `<br><small style="color:var(--red,#e53e3e);font-size:11px">${escapeHtml(job.errorCode)}</small>` : ""}</td>
      <td>${Number(job.costCredits || 0)}</td>
      <td>${timingCell(job)}</td>
      <td title="${escapeHtml(job.prompt || "")}">${escapeHtml(clip(job.prompt, 92))}${job.status === "failed" && job.errorMessage ? `<br><small style="color:var(--red,#e53e3e);font-size:11px" title="${escapeHtml(job.errorMessage)}">${escapeHtml(clip(job.errorMessage, 80))}</small>` : ""}</td>
      <td>${formatDate(job.createdAt)}</td>
      <td><div class="row-actions task-row-actions"><button class="icon-only" data-action="job-menu" aria-label="更多操作">···</button></div></td>
    </tr>
  `).join("") || tableEmpty(9);
}

function filteredGalleryImages() {
  const search = $("gallerySearch")?.value || "";
  const status = $("galleryStatusFilter")?.value || "";
  return (state.gallery.images || [])
    .filter((item) => !status || item.status === status)
    .filter((item) => includesText(
      search,
      item.id,
      item.taskId,
      item.userEmail,
      item.userName,
      item.userId,
      item.model,
      item.prompt,
      item.gatewayId,
      item.requestId,
      item.status,
      item.size,
      item.quality,
    ));
}

function renderGalleryStats(rows = filteredGalleryImages()) {
  const total = Number(state.gallery.total || 0);
  const maxItems = Number(state.gallery.maxItems || 3000);
  const pageStart = total === 0 ? 0 : Number(state.gallery.offset || 0) + 1;
  const pageEnd = Math.min(Number(state.gallery.offset || 0) + Number(state.gallery.limit || 0), total);
  const uniqueUsers = new Set(rows.map((item) => item.userId).filter(Boolean)).size;
  const success = rows.filter((item) => item.status === "succeeded").length;
  $("galleryStats").innerHTML = [
    statCard("可浏览图片", total, `最近上限 ${maxItems} 张`),
    statCard("当前页范围", `${pageStart}-${pageEnd}`, `每页 ${state.gallery.limit} 张`),
    statCard("当前页命中", rows.length, `${uniqueUsers} 个用户`),
    statCard("成功图片", success, "当前筛选页内"),
  ].join("");
}

function renderGallery() {
  const rows = filteredGalleryImages();
  renderGalleryStats(rows);
  const pageCount = Number(state.gallery.pageCount || 0);
  const page = Number(state.gallery.page || 0);
  $("galleryMeta").textContent = `最近 ${state.gallery.maxItems} 张生成图片，当前加载 ${state.gallery.images.length} 张`;
  $("galleryPageInfo").textContent = pageCount ? `${page}/${pageCount}` : "0/0";
  $("galleryPrevPage").disabled = state.gallery.offset <= 0;
  $("galleryNextPage").disabled = pageCount === 0 || page >= pageCount;
  $("galleryPageSize").value = String(state.gallery.limit || 500);
  $("galleryGrid").innerHTML = rows.map((item) => {
    const imageUrl = galleryImageUrl(item);
    return `
      <article class="gallery-card" data-id="${escapeHtml(item.id)}">
        <button class="gallery-thumb" data-action="detail-gallery-image" type="button" aria-label="查看作品详情">
          ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(clip(item.prompt || "生成图片", 48))}" loading="lazy" />` : `<span>无图</span>`}
        </button>
        <div class="gallery-card-meta">
          <strong title="${escapeHtml(item.prompt || "")}">${escapeHtml(clip(item.prompt || "无提示词", 34))}</strong>
          <span>${escapeHtml(item.userEmail || item.userName || item.userId || "未知用户")}</span>
          <small>${escapeHtml(item.model || "-")} · ${formatShortDate(item.createdAt)}</small>
        </div>
      </article>
    `;
  }).join("") || `<div class="empty-gallery">没有匹配的图片</div>`;
}

function renderRiskStats() {
  const enabled = state.sensitiveRules.filter((rule) => rule.enabled).length;
  const disabled = state.sensitiveRules.length - enabled;
  const openAlerts = state.riskAlerts.filter((alert) => alert.status === "open").length;
  const todayAlerts = state.riskAlerts.filter((alert) => isWithin(alert.createdAt, 24)).length;
  $("riskStats").innerHTML = [
    statCard("启用规则", `${enabled}/${state.sensitiveRules.length}`, disabled ? `${disabled} 条停用` : "当前生效"),
    statCard("最新告警", state.riskAlerts.length, "最近列表范围"),
    statCard("待处理", openAlerts, "需要管理员关注"),
    statCard("今日命中", todayAlerts, "过去 24 小时"),
  ].join("");
}

function filteredRiskAlerts() {
  const search = $("riskSearch").value;
  const status = $("riskStatusFilter").value;
  return state.riskAlerts
    .filter((alert) => !status || alert.status === status)
    .filter((alert) => includesText(
      search,
      alert.id,
      alert.userEmail,
      alert.userName,
      alert.userId,
      alert.ruleName,
      alert.rulePattern,
      alert.matchedText,
      alert.prompt,
      alert.requestId,
      alert.apiKeyPrefix,
    ));
}

function filteredSensitiveRules() {
  const search = $("ruleSearch").value;
  const status = $("ruleStatusFilter").value;
  return state.sensitiveRules
    .filter((rule) => !status || (status === "enabled" ? rule.enabled : !rule.enabled))
    .filter((rule) => includesText(search, rule.id, rule.name, rule.pattern));
}

function renderRiskAlerts() {
  const rows = filteredRiskAlerts();
  $("riskAlertRows").innerHTML = rows.map((alert) => `
    <tr data-id="${escapeHtml(alert.id)}">
      <td>${formatDate(alert.createdAt)}</td>
      <td><div class="cell-stack"><strong>${escapeHtml(alert.userEmail || alert.userId)}</strong><small>${escapeHtml(alert.userName || alert.userId)}</small></div></td>
      <td><div class="cell-stack"><strong>${escapeHtml(alert.matchedText || "-")}</strong><small>${escapeHtml(clip(alert.ruleName || alert.rulePattern, 48))}</small></div></td>
      <td title="${escapeHtml(alert.prompt || "")}">${escapeHtml(clip(alert.prompt, 96))}</td>
      <td><div class="cell-stack"><strong>${escapeHtml(alert.source || "-")}</strong><small>${escapeHtml(alert.requestId || alert.apiKeyPrefix || "")}</small></div></td>
      <td><button class="small" data-action="detail-risk-alert" type="button">详情</button></td>
    </tr>
  `).join("") || tableEmpty(6);
}

function renderSensitiveRules() {
  const rows = filteredSensitiveRules();
  $("sensitiveWordRows").innerHTML = rows.map((rule) => `
    <tr data-id="${escapeHtml(rule.id)}">
      <td>
        <div class="cell-stack risk-rule-cell">
          <input data-field="rule-name" value="${escapeHtml(rule.name || "")}" placeholder="规则名称，可选" />
          <textarea data-field="rule-pattern" rows="2" spellcheck="false">${escapeHtml(rule.pattern || "")}</textarea>
          <small>${escapeHtml(rule.id)}</small>
        </div>
      </td>
      <td>${statusBadge(rule.enabled ? "enabled" : "disabled")}</td>
      <td>${Number(rule.alertCount || 0)}</td>
      <td>${formatDate(rule.lastHitAt)}</td>
      <td>${formatDate(rule.updatedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="small primary" data-action="save-sensitive-rule" type="button">保存</button>
          <button class="small" data-action="toggle-sensitive-rule" type="button">${rule.enabled ? "停用" : "启用"}</button>
          <button class="small danger" data-action="delete-sensitive-rule" type="button">删除</button>
        </div>
      </td>
    </tr>
  `).join("") || tableEmpty(6);
}

function renderRisk() {
  renderRiskStats();
  renderRiskAlerts();
  renderSensitiveRules();
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

function filteredCodes() {
  const search = $("codeSearch").value;
  const status = $("codeStatusFilter").value;
  return state.codes
    .filter((code) => !status || (status === "active" ? code.active : !code.active))
    .filter((code) => includesText(search, code.code, code.activityKey));
}

function renderCodes() {
  renderCodeStats();
  const rows = filteredCodes();

  $("codeRows").innerHTML = rows.map((code) => `
    <tr data-id="${code.id}">
      <td>
        <div class="code-cell">
          <strong>${escapeHtml(code.code)}</strong>
          <button class="small" data-action="copy-code" type="button">复制</button>
        </div>
      </td>
      <td><code>${escapeHtml(code.activityKey || code.code)}</code></td>
      <td>${Number(code.credits || 0)}</td>
      <td>${(code.usedBy || []).length}/${code.maxUses}</td>
      <td>${formatDate(code.expiresAt)}</td>
      <td>${statusBadge(code.active ? "enabled" : "disabled")}</td>
      <td>
        <div class="row-actions">
          <button class="small ${code.active ? "danger" : ""}" data-action="toggle-code" type="button">${code.active ? "停用" : "启用"}</button>
          ${(code.usedBy || []).length > 0 ? `<button class="small danger" data-action="delete-code" type="button">删除</button>` : ""}
        </div>
      </td>
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

function codeBatchText(includeMeta = false) {
  return state.lastCreatedCodes.map((code) => {
    if (!includeMeta) return code.code;
    return [code.code, code.activityKey || "", code.credits || "", code.maxUses || ""].join("\t");
  }).join("\n");
}

function showCreatedCodesPopover(codes) {
  state.lastCreatedCodes = Array.isArray(codes) ? codes.filter(Boolean) : [];
  if (!state.lastCreatedCodes.length) return;
  const first = state.lastCreatedCodes[0];
  $("codeBatchTitle").textContent = state.lastCreatedCodes.length > 1 ? `已生成 ${state.lastCreatedCodes.length} 个兑换码` : "已生成 1 个兑换码";
  $("codeBatchMeta").textContent = `${first.activityKey || first.code} · ${Number(first.credits || 0)} 积分 · 每码 ${first.maxUses || 1} 次`;
  $("codeBatchList").textContent = codeBatchText(false);
  $("codeBatchScrim").classList.remove("hidden");
  $("codeBatchPopover").classList.remove("hidden");
  $("codeBatchPopover").setAttribute("aria-hidden", "false");
}

function closeCreatedCodesPopover() {
  $("codeBatchScrim").classList.add("hidden");
  $("codeBatchPopover").classList.add("hidden");
  $("codeBatchPopover").setAttribute("aria-hidden", "true");
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
  const warnings = userWarnings(user);
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
      <h3>风险警告</h3>
      ${fieldRow("待确认", warnings.length)}
      ${warnings.length ? `
        <div class="warning-list">
          ${warnings.slice(0, 3).map((warning) => `
            <div class="warning-item">
              <strong>${escapeHtml(formatDate(warning.createdAt))}</strong>
              <span>${escapeHtml(clip(warning.message, 96))}</span>
            </div>
          `).join("")}
        </div>
      ` : `<p class="drawer-helper">暂无待确认警告</p>`}
      <button class="drawer-action warning-action" type="button" data-drawer-action="warn-user" data-user-id="${escapeHtml(user.id)}">发送风险警告</button>
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
    <div class="detail-section danger-zone">
      <h3>危险操作</h3>
      <p class="drawer-helper">删除用户会移除该账号、API Key、任务、图片结果、积分流水和兑换记录。此操作不可恢复。</p>
      <button class="drawer-action danger" type="button" data-drawer-action="delete-user" data-user-id="${escapeHtml(user.id)}">删除用户</button>
    </div>
  `);
}

function showUserWarningForm(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  openDrawer("发送风险警告", user.email, `
    <div class="detail-section">
      <h3>警告对象</h3>
      ${fieldRow("用户", user.email)}
      ${fieldRow("用户 ID", user.id)}
    </div>
    <div class="detail-section">
      <h3>弹窗内容</h3>
      <div class="drawer-warning-form">
        <label>类别<input id="drawerWarningCategory" value="risk" maxlength="80" /></label>
        <label>警告文案<textarea id="drawerWarningMessage" rows="6" maxlength="2000">${escapeHtml(DEFAULT_USER_WARNING_MESSAGE)}</textarea></label>
        <p class="drawer-helper">用户下次刷新或登录后会收到可关闭弹窗，关闭后标记为已确认。</p>
        <div class="drawer-credit-actions">
          <button class="primary" id="drawerWarningSubmit" type="button" data-user-id="${escapeHtml(user.id)}">发送警告</button>
        </div>
      </div>
    </div>
  `);
}

function showUserDeleteConfirm(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  const jobs = state.jobs.filter((job) => job.userId === user.id);
  openDrawer("确认删除用户", user.email, `
    <div class="detail-section delete-confirm-box">
      <h3>二次确认</h3>
      <p>请输入该用户邮箱以确认删除。删除后该账号、API Key、任务、图片结果、积分流水、兑换记录和未确认警告都会被移除。</p>
      <div class="delete-impact-grid">
        ${fieldRow("用户", user.email)}
        ${fieldRow("任务", jobs.length)}
        ${fieldRow("积分余额", Number(user.credits || 0))}
        ${fieldRow("待确认警告", userWarnings(user).length)}
      </div>
      <label class="delete-confirm-label">确认邮箱<input id="drawerDeleteUserEmail" autocomplete="off" placeholder="${escapeHtml(user.email)}" /></label>
      <div class="drawer-credit-actions">
        <button class="danger" id="drawerDeleteUserSubmit" type="button" data-user-id="${escapeHtml(user.id)}" data-user-email="${escapeHtml(user.email)}" disabled>确认删除</button>
      </div>
    </div>
  `);
}

function showJobDetail(id) {
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  const resultUrl = adminJobResultUrl(job);
  const timing = job.timing || {};
  const totalMs = jobTotalLatency(job);
  const queueMs = job.queueLatencyMs ?? timing.queueMs;
  const processingMs = job.processingLatencyMs ?? timing.processingMs;
  const currentMs = job.currentLatencyMs ?? timing.currentMs;
  const bottleneck = job.timingBottleneck || timing.bottleneck || "unknown";
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
      ${fieldRow("开始处理", formatDate(job.startedAt))}
      ${fieldRow("完成时间", formatDate(job.completedAt))}
      ${fieldRow("错误码", job.errorCode || "-")}
      ${fieldRow("错误原因", job.errorMessage || "-")}
    </div>
    <div class="detail-section">
      <h3>耗时诊断</h3>
      <div class="timing-breakdown">
        <div><span>总耗时</span><strong>${escapeHtml(formatLatency(totalMs))}</strong></div>
        <div><span>排队等待</span><strong>${escapeHtml(formatLatency(queueMs))}</strong></div>
        <div><span>生成处理</span><strong>${escapeHtml(formatLatency(processingMs))}</strong></div>
        <div><span>当前耗时</span><strong>${escapeHtml(formatLatency(currentMs))}</strong></div>
      </div>
      ${fieldRow("主要慢点", jobBottleneckLabel(bottleneck))}
      ${fieldRow("诊断原因", jobTimingReason(job))}
      ${fieldRow("重试", `${Number(job.retryCount || 0)}/${Number(job.maxRetries || 0)}`)}
    </div>
    <div class="detail-section">
      <h3>提示词</h3>
      <p class="prompt-box">${escapeHtml(job.prompt || "-")}</p>
    </div>
  `);
}

function showGalleryDetail(id) {
  const item = (state.gallery.images || []).find((image) => image.id === id);
  if (!item) return;
  const imageUrl = item.url || item.thumbnailUrl || "";
  openDrawer("作品详情", `${item.userEmail || item.userId || "未知用户"} · ${formatDate(item.createdAt)}`, `
    ${imageUrl ? `<a class="drawer-result" href="${escapeHtml(imageUrl)}" target="_blank" rel="noreferrer">打开原图</a>` : ""}
    ${imageUrl ? `
      <div class="detail-section">
        <h3>图片预览</h3>
        <div class="drawer-preview-card gallery-drawer-preview">
          <img class="drawer-preview" src="${escapeHtml(imageUrl)}" alt="作品预览" loading="lazy" />
        </div>
      </div>
    ` : ""}
    <div class="detail-section">
      <h3>图片信息</h3>
      ${fieldRow("图片 ID", item.id)}
      ${fieldRow("任务 ID", item.taskId)}
      ${fieldRow("尺寸", item.width && item.height ? `${item.width} × ${item.height}` : item.size || "-")}
      ${fieldRow("格式", item.format || "-")}
      ${fieldRow("大小", item.sizeBytes ? `${Math.round(Number(item.sizeBytes) / 1024)} KB` : "-")}
      ${fieldRow("生成时间", formatDate(item.createdAt))}
    </div>
    <div class="detail-section">
      <h3>用户与任务</h3>
      ${fieldRow("用户", item.userEmail || item.userName || item.userId || "-")}
      ${fieldRow("模型", item.model || "-")}
      ${fieldRow("质量", item.quality || "-")}
      ${fieldRow("状态", statusLabel(item.status))}
      ${fieldRow("积分", Number(item.costCredits || 0))}
      ${fieldRow("渠道", item.gatewayId || "-")}
      ${fieldRow("耗时", item.latencyMs ? formatLatency(item.latencyMs) : "-")}
    </div>
    <div class="detail-section">
      <h3>提示词</h3>
      <p class="prompt-box">${escapeHtml(item.prompt || "-")}</p>
    </div>
    <div class="detail-section">
      <h3>快捷操作</h3>
      <div class="drawer-action-list">
        <button class="drawer-action" type="button" data-drawer-action="detail-job" data-job-id="${escapeHtml(item.taskId)}">查看关联任务</button>
        ${imageUrl ? `<a class="drawer-action" href="${escapeHtml(imageUrl)}" target="_blank" rel="noreferrer">新窗口打开</a>` : ""}
      </div>
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

function showRiskAlertDetail(id) {
  const alert = state.riskAlerts.find((item) => item.id === id);
  if (!alert) return;
  openDrawer("敏感词告警", `${alert.userEmail || alert.userId} · ${formatDate(alert.createdAt)}`, `
    <div class="detail-section">
      <h3>告警</h3>
      ${fieldRow("告警 ID", alert.id)}
      ${fieldRow("状态", alert.status || "-")}
      ${fieldRow("来源", alert.source || "-")}
      ${fieldRow("时间", formatDate(alert.createdAt))}
      ${fieldRow("Request ID", alert.requestId || "-")}
      ${fieldRow("API Key", alert.apiKeyPrefix || alert.apiKeyId || "-")}
    </div>
    <div class="detail-section">
      <h3>用户</h3>
      ${fieldRow("用户", alert.userEmail || alert.userId)}
      ${fieldRow("昵称", alert.userName || "-")}
      ${fieldRow("用户 ID", alert.userId)}
    </div>
    <div class="detail-section">
      <h3>命中规则</h3>
      ${fieldRow("规则", alert.ruleName || alert.ruleId || "-")}
      ${fieldRow("命中文本", alert.matchedText || "-")}
      <pre class="json-block">${escapeHtml(alert.rulePattern || "")}</pre>
    </div>
    <div class="detail-section">
      <h3>用户输入</h3>
      <p class="prompt-box">${escapeHtml(alert.prompt || "-")}</p>
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

function isMaskedApiKey(value) {
  const text = String(value || "").trim();
  return text.includes("****") || text.includes("••••") || /^[*•]+$/.test(text);
}

function gatewayTestMessage(response) {
  if (response.ok) return `测试成功 · ${formatLatency(response.latencyMs)}`;
  return `测试失败${response.error ? `：${response.error}` : ""}`;
}

function callSquareDiagnosis(result) {
  if (!result || result.ok) return "";
  const localStatus = String(result.localStatus || result.apiStatus || "");
  const upstreamStatus = Number(result.status || 0);
  const errorCode = String(result.errorCode || "");
  const rawPreview = String(result.rawPreview || "");
  if (localStatus.includes("504") && !upstreamStatus) {
    return "本机接口先返回 504，后端没有等到上游结果。通常是站点入口 Nginx / 网关的 proxy_read_timeout、send_timeout 或平台请求时限短于这里填写的超时。需要把入口代理超时调大到高于本页超时，或降低图片数量/尺寸后重试。";
  }
  if (upstreamStatus === 504 || rawPreview.toLowerCase().includes("504 gateway time-out")) {
    return "远端上游返回 504。请求已经发到你填写的上游地址，但上游自己的 Nginx / 网关在模型完成前超时，需上游侧提高超时或排查模型服务耗时。";
  }
  if (errorCode === "UPSTREAM_TIMEOUT") {
    return "本服务等待上游超过本页设置的超时限制。可以适当增大超时，但如果入口代理超时更短，仍会先看到本机接口 504。";
  }
  if (result.mode === "edit" && Number(result.referenceCount || 0) > 0) {
    return "参考图会走 images/edits 的 multipart 请求，上传和编辑通常比纯文本生成更慢；多图、高清和复杂提示词都会增加超时概率。";
  }
  return "";
}

function callSquareRequestUrl(rawUrl) {
  return String(rawUrl || "").trim();
}

function callSquareEditUrl(rawUrl) {
  const url = callSquareRequestUrl(rawUrl);
  if (url.includes("/images/edits")) return url;
  if (url.includes("/images/generations")) return url.replace("/images/generations", "/images/edits");
  return url;
}

function parseCallSquareRequestBody(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("请求参数 JSON 不能为空");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("请求参数必须是合法 JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("请求参数 JSON 必须是对象");
  }
  return parsed;
}

function prettyCallSquareRequestBody(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return DEFAULT_CALL_SQUARE_CONFIG.requestBody;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return DEFAULT_CALL_SQUARE_CONFIG.requestBody;
}

function callSquareFormData() {
  const form = $("callSquareForm");
  const data = formData(form);
  const requestBody = prettyCallSquareRequestBody(data.requestBody || DEFAULT_CALL_SQUARE_CONFIG.requestBody);
  const timeoutMs = Math.min(Math.max(Number(data.timeoutMs || 90000), 1000), MAX_CALL_SQUARE_TIMEOUT_MS);
  return {
    url: callSquareRequestUrl(data.url),
    apiKey: String(data.apiKey || "").trim(),
    upstreamGroup: String(data.upstreamGroup || "").trim(),
    requestBody,
    timeoutMs,
  };
}

function callSquareTestPayload(data) {
  if (!state.callSquareReferenceFiles.length) {
    return { body: JSON.stringify(data) };
  }
  const body = new FormData();
  Object.entries(data).forEach(([key, value]) => body.append(key, value == null ? "" : String(value)));
  state.callSquareReferenceFiles.forEach((file) => body.append("image[]", file, file.name || "reference.png"));
  return { body };
}

function revokeCallSquareReferenceUrls() {
  state.callSquareReferenceUrls.forEach((url) => URL.revokeObjectURL(url));
  state.callSquareReferenceUrls = [];
}

function clearCallSquareReferences({ silent = false } = {}) {
  revokeCallSquareReferenceUrls();
  state.callSquareReferenceFiles = [];
  const input = $("callSquareImages");
  if (input) input.value = "";
  renderCallSquareReferences();
  if (!silent) toast("已清空参考图", "success");
}

function addCallSquareReferences(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return;
  const maxBytes = 50 * 1024 * 1024;
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
  const invalid = incoming.find((file) => !allowedTypes.has(String(file.type || "").toLowerCase()));
  if (invalid) throw new Error("参考图仅支持 PNG、JPG、WEBP");
  const oversized = incoming.filter((file) => file.size > maxBytes);
  if (oversized.length) throw new Error(`图片过大（最大 50MB）：${oversized.map((file) => file.name).join("、")}`);
  state.callSquareReferenceFiles = [...state.callSquareReferenceFiles, ...incoming].slice(0, 16);
  const input = $("callSquareImages");
  if (input) input.value = "";
  renderCallSquareReferences();
}

function renderCallSquareReferences() {
  const tray = $("callSquareReferenceTray");
  if (!tray) return;
  revokeCallSquareReferenceUrls();
  tray.replaceChildren();
  const files = state.callSquareReferenceFiles;
  tray.classList.toggle("empty", !files.length);
  $("callSquareClearReferences")?.classList.toggle("hidden", !files.length);
  if (!files.length) {
    const empty = document.createElement("span");
    empty.textContent = "暂无参考图";
    tray.appendChild(empty);
    return;
  }
  files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.callSquareReferenceUrls.push(url);
    const item = document.createElement("div");
    item.className = "call-square-reference-item";
    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name || `参考图 ${index + 1}`;
    const meta = document.createElement("span");
    meta.textContent = String(index + 1);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "移除参考图";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.callSquareReferenceFiles.splice(index, 1);
      renderCallSquareReferences();
    });
    item.append(img, meta, remove);
    tray.appendChild(item);
  });
}

function applyCallSquareConfig(config = {}) {
  const form = $("callSquareForm");
  if (!form) return;
  const next = { ...DEFAULT_CALL_SQUARE_CONFIG, ...config };
  state.callSquareConfig = next;
  Object.entries({
    url: next.url,
    apiKey: next.apiKey || "",
    upstreamGroup: next.upstreamGroup,
    requestBody: prettyCallSquareRequestBody(next.requestBody),
    timeoutMs: next.timeoutMs,
  }).forEach(([key, value]) => {
    if (form.elements[key]) form.elements[key].value = value ?? "";
  });
}

async function loadCallSquareConfig() {
  const payload = await api("/api/admin/call-square/config");
  applyCallSquareConfig(payload.config || {});
  state.callSquareConfigLoaded = true;
}

async function saveCallSquareConfig(button) {
  await withBusy(button, "保存中", async () => {
    const data = callSquareFormData();
    parseCallSquareRequestBody(data.requestBody);
    const payload = await api("/api/admin/call-square/config", { method: "PATCH", body: JSON.stringify(data) });
    applyCallSquareConfig(payload.config || {});
  });
  toast("调用配置已保存", "success");
}

function renderCallSquareResult(result) {
  const target = $("callSquareResult");
  if (!target) return;
  if (!result) {
    target.className = "call-square-result empty";
    target.innerHTML = `
      <div class="call-square-empty">
        <strong>等待生成</strong>
        <span>提交后会用这组渠道参数生成一张测试图片。</span>
      </div>
    `;
    return;
  }
  const imageUrl = result.image?.url || "";
  const localStatus = result.localStatus || result.apiStatus || "";
  const errorText = [result.errorCode, result.error].filter(Boolean).join("：");
  const modeText = result.mode === "edit" ? `参考图编辑 · ${Number(result.referenceCount || 0)} 张` : "文本生成";
  const diagnosis = callSquareDiagnosis(result);
  target.className = `call-square-result ${result.ok ? "ok" : "error"}`;
  target.innerHTML = `
    <div class="call-square-result-head">
      <div>
        <span>${result.ok ? "生成成功" : "生成失败"}</span>
        <strong>${escapeHtml(result.model || "-")}</strong>
      </div>
      ${statusBadge(result.ok ? "healthy" : "failed")}
    </div>
    <div class="call-square-preview ${imageUrl ? "" : "empty"}">
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="调用广场生成结果" />` : `<span>没有图片返回</span>`}
    </div>
    <div class="call-square-kpis">
      <div><span>上游 HTTP</span><strong>${escapeHtml(result.status || 0)}</strong></div>
      <div><span>耗时</span><strong>${escapeHtml(formatLatency(result.latencyMs))}</strong></div>
      <div><span>尺寸</span><strong>${escapeHtml(result.size || "-")}</strong></div>
      <div><span>模式</span><strong>${escapeHtml(modeText)}</strong></div>
    </div>
    <div class="call-square-detail">
      ${localStatus ? `<label>本机接口<input readonly value="${escapeHtml(localStatus)}" /></label>` : ""}
      <label>上游地址<input readonly value="${escapeHtml(result.url || "-")}" /></label>
      ${errorText ? `<div class="call-square-error">${escapeHtml(errorText)}</div>` : ""}
      ${diagnosis ? `<div class="call-square-diagnosis"><strong>诊断</strong><span>${escapeHtml(diagnosis)}</span></div>` : ""}
      ${result.prompt ? `<div class="call-square-prompt-preview">${escapeHtml(result.prompt)}</div>` : ""}
      ${imageUrl ? `<button class="small" data-action="copy-call-square-image" data-url="${escapeHtml(imageUrl)}" type="button">复制图片地址</button>` : ""}
      ${result.requestBody ? `<details class="call-square-raw"><summary>请求参数</summary><pre>${escapeHtml(JSON.stringify(result.requestBody, null, 2))}</pre></details>` : ""}
      ${result.rawPreview ? `<details class="call-square-raw"><summary>原始返回</summary><pre>${escapeHtml(result.rawPreview)}</pre></details>` : ""}
    </div>
  `;
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
  setMobileNavOpen(false);
  $$("#nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === nextView));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === nextView));
  $("viewTitle").textContent = titles[nextView][0];
  $("viewSubtitle").textContent = titles[nextView][1];
  const activeTab = $("activeTab");
  if (activeTab) activeTab.textContent = titles[nextView][0];
  renderQuickActions(nextView);
  if (nextView === "gallery" && state.user?.role === "admin" && !state.gallery.images.length) {
    loadGallery().catch((error) => toast(error.message, "error"));
  }
  if (nextView === "call-square" && state.user?.role === "admin" && !state.callSquareConfigLoaded) {
    loadCallSquareConfig().catch((error) => toast(error.message, "error"));
  }
  const searchId = searchTargets[nextView];
  $("globalSearch").value = searchId ? $(searchId).value : "";
  $("globalSearch").placeholder = searchId ? `搜索${titles[nextView][0]}` : "搜索当前页面";
  syncMobileDock(nextView);
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
  if (window.matchMedia("(max-width: 760px)").matches) {
    setMobileNavOpen(!document.body.classList.contains("mobile-nav-open"));
    return;
  }
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? "1" : "0");
  applyShellState();
});

$("mobileDock")?.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-mobile-view]");
  if (viewButton) {
    switchView(viewButton.dataset.mobileView);
    return;
  }
  if (event.target.closest("[data-mobile-menu]")) {
    setMobileNavOpen(true);
  }
});

$("mobileNavScrim")?.addEventListener("click", () => setMobileNavOpen(false));

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 760px)").matches) setMobileNavOpen(false);
  applyShellState();
});

document.addEventListener("click", async (event) => {
  const successScopeButton = event.target.closest("[data-success-rate-scope]");
  if (successScopeButton) {
    state.successRateScope = successScopeButton.dataset.successRateScope === "all" ? "all" : "24h";
    localStorage.setItem(STORAGE_KEYS.successRateScope, state.successRateScope);
    renderOverview();
    return;
  }

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
    if (action === "focus") {
      const field = $(target);
      if (field) {
        field.scrollIntoView({ behavior: "smooth", block: "center" });
        field.focus();
      }
    }
  }
  const detailTarget = event.target.closest("[data-open-detail]");
  if (detailTarget) {
    const type = detailTarget.dataset.openDetail;
    const id = detailTarget.dataset.id;
    if (type === "gateway") showGatewayDetail(id);
    if (type === "job") showJobDetail(id);
    if (type === "gallery") showGalleryDetail(id);
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
  if (event.target.closest("[data-action='reload-gallery']")) {
    const button = event.target.closest("[data-action='reload-gallery']");
    try {
      await withBusy(button, "刷新中", () => loadGallery());
      toast("作品看板已刷新", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }
  if (event.target.closest("[data-action='copy-call-square-image']")) {
    const button = event.target.closest("[data-action='copy-call-square-image']");
    try {
      await withBusy(button, "复制中", () => copyText(button.dataset.url || ""));
      toast("图片地址已复制", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  }
});

$("closeDrawer").addEventListener("click", closeDrawer);
$("drawerScrim").addEventListener("click", closeDrawer);

$("usageDaysTabs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".days-tab");
  if (!btn) return;
  state.usageDays = parseInt(btn.dataset.days, 10);
  $("usageDaysTabs").querySelectorAll(".days-tab").forEach(b => b.classList.toggle("active", b === btn));
  try {
    state.usage = await api("/api/admin/usage?days=" + state.usageDays);
    renderUsage();
  } catch (err) { toast(err.message, "error"); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawer();
    closeCreatedCodesPopover();
  }
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

$("callSquareForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  let submittedData = null;
  try {
    await withBusy(button, "测试中", async () => {
      submittedData = callSquareFormData();
      validateGatewayPayload({ baseUrl: submittedData.url, apiKey: submittedData.apiKey });
      parseCallSquareRequestBody(submittedData.requestBody);
      if (isMaskedApiKey(submittedData.apiKey) && !state.callSquareConfig.apiKeyConfigured) {
        throw new Error("当前 API Key 是掩码值，但后台没有已保存的真实 Key，请重新填写完整 sk-...");
      }
      const result = await api("/api/admin/call-square/test", { method: "POST", ...callSquareTestPayload(submittedData) });
      renderCallSquareResult(result);
      toast(result.ok ? "生成成功" : (result.error || "生成失败"), result.ok ? "success" : "error");
    });
  } catch (error) {
    const payload = error.payload || {};
    let requestBody = payload.requestBody || null;
    if (!requestBody && submittedData?.requestBody) {
      try {
        requestBody = parseCallSquareRequestBody(submittedData.requestBody);
      } catch {
        requestBody = null;
      }
    }
    renderCallSquareResult({
      ok: false,
      status: payload.status || 0,
      localStatus: error.status ? `HTTP ${error.status}` : "",
      latencyMs: payload.latencyMs || 0,
      model: payload.model || requestBody?.model || "",
      prompt: payload.prompt || requestBody?.prompt || "",
      size: payload.size || requestBody?.size || "",
      image: null,
      errorCode: payload.errorCode || payload.error || "",
      error: payload.message || payload.error || error.message,
      url: payload.url || (state.callSquareReferenceFiles.length ? callSquareEditUrl(submittedData?.url || form.elements.url?.value || "") : callSquareRequestUrl(submittedData?.url || form.elements.url?.value || "")),
      mode: payload.mode || (state.callSquareReferenceFiles.length ? "edit" : "generation"),
      referenceCount: payload.referenceCount ?? state.callSquareReferenceFiles.length,
      requestBody,
      rawPreview: payload.rawPreview || error.responseText || "",
    });
    toast(error.message, "error");
  }
});

$("callSquareSaveConfig").addEventListener("click", async (event) => {
  try {
    await saveCallSquareConfig(event.currentTarget);
  } catch (error) {
    toast(error.message, "error");
  }
});

$("callSquareClearConfig").addEventListener("click", () => {
  applyCallSquareConfig(DEFAULT_CALL_SQUARE_CONFIG);
  clearCallSquareReferences({ silent: true });
  renderCallSquareResult(null);
  toast("已恢复默认测试参数", "success");
});

$("callSquareImages")?.addEventListener("change", (event) => {
  try {
    addCallSquareReferences(event.currentTarget.files);
    toast(state.callSquareReferenceFiles.length ? `已添加 ${state.callSquareReferenceFiles.length} 张参考图` : "未选择参考图", "success");
  } catch (error) {
    event.currentTarget.value = "";
    toast(error.message, "error");
  }
});

$("callSquareClearReferences")?.addEventListener("click", () => {
  clearCallSquareReferences();
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

$("enableHealthyGateways").addEventListener("click", async () => {
  try {
    await withBusy($("enableHealthyGateways"), "处理中", async () => {
      const tripped = state.gateways.filter((g) => g.enabled && isCoolingDown(g));
      if (!tripped.length) { toast("没有熔断中的渠道", "success"); return; }
      let enabled = 0;
      for (const gateway of tripped) {
        const result = await api(`/api/admin/gateways/${gateway.id}/health-check`, { method: "POST" });
        upsertById(state.gateways, result.gateway);
        if (result.ok) {
          const { gateway: updated } = await api(`/api/admin/gateways/${gateway.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true, consecutiveFailures: 0, disabledUntil: null }) });
          upsertById(state.gateways, updated);
          appendAuditLog("gateway.update", gateway.id, { enabled: true });
          enabled++;
        }
      }
      rerenderAfterMutation();
      toast(enabled ? `已启用 ${enabled} / ${tripped.length} 个健康渠道` : `检测完成，${tripped.length} 个渠道均不健康`, enabled ? "success" : "error");
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

$("galleryGrid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='detail-gallery-image']");
  if (!button) return;
  const card = button.closest(".gallery-card");
  if (card) showGalleryDetail(card.dataset.id);
});

$("galleryPrevPage").addEventListener("click", async () => {
  if (state.gallery.offset <= 0) return;
  state.gallery.offset = Math.max(0, state.gallery.offset - state.gallery.limit);
  try {
    await loadGallery();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("galleryNextPage").addEventListener("click", async () => {
  if (state.gallery.page >= state.gallery.pageCount) return;
  state.gallery.offset += state.gallery.limit;
  try {
    await loadGallery();
  } catch (error) {
    toast(error.message, "error");
  }
});

$("galleryPageSize").addEventListener("change", async (event) => {
  state.gallery.limit = Number(event.target.value || 500);
  state.gallery.offset = 0;
  try {
    await loadGallery();
  } catch (error) {
    toast(error.message, "error");
  }
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
            <button class="drawer-action" type="button" data-drawer-action="warn-user" data-user-id="${escapeHtml(user.id)}">发送风险警告</button>
            <button class="drawer-action danger" type="button" data-drawer-action="delete-user" data-user-id="${escapeHtml(user.id)}">删除用户</button>
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

$("drawerBody").addEventListener("input", (event) => {
  const input = event.target.closest("#drawerDeleteUserEmail");
  if (!input) return;
  const button = $("drawerDeleteUserSubmit");
  if (!button) return;
  button.disabled = input.value.trim() !== button.dataset.userEmail;
});

$("drawerBody").addEventListener("click", async (event) => {
  const drawerButton = event.target.closest("[data-drawer-action], #drawerCreditSubmit, #drawerWarningSubmit, #drawerDeleteUserSubmit");
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

    if (drawerButton.id === "drawerWarningSubmit") {
      const userId = drawerButton.dataset.userId;
      const message = $("drawerWarningMessage")?.value.trim() || DEFAULT_USER_WARNING_MESSAGE;
      const category = $("drawerWarningCategory")?.value.trim() || "risk";
      const { user, warning } = await withBusy(drawerButton, "发送中", () => api("/api/admin/user-warnings", {
        method: "POST",
        body: JSON.stringify({ userId, message, category }),
      }));
      upsertById(state.users, user);
      appendAuditLog("user.warning.create", userId, { warningId: warning?.id, category });
      rerenderAfterMutation();
      toast("风险警告已发送", "success");
      showUserDetail(userId);
      return;
    }

    if (drawerButton.id === "drawerDeleteUserSubmit") {
      const userId = drawerButton.dataset.userId;
      const expectedEmail = drawerButton.dataset.userEmail || "";
      const typedEmail = $("drawerDeleteUserEmail")?.value.trim() || "";
      if (typedEmail !== expectedEmail) throw new Error("请输入完整用户邮箱以确认删除");
      await withBusy(drawerButton, "删除中", () => api(`/api/admin/users/${userId}`, { method: "DELETE" }));
      const deletedUser = state.users.find((item) => item.id === userId);
      state.users = state.users.filter((item) => item.id !== userId);
      state.jobs = state.jobs.filter((job) => job.userId !== userId);
      state.gallery.images = (state.gallery.images || []).filter((image) => image.userId !== userId);
      state.riskAlerts = state.riskAlerts.filter((alert) => alert.userId !== userId);
      state.selected.users.delete(userId);
      clearRowDraft("users", userId);
      appendAuditLog("user.delete", userId, { email: deletedUser?.email });
      await loadAll().catch(() => rerenderAfterMutation());
      closeDrawer();
      toast("用户已删除", "success");
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

    if (action === "warn-user") {
      showUserWarningForm(userId);
      return;
    }

    if (action === "delete-user") {
      showUserDeleteConfirm(userId);
      return;
    }

    if (action === "detail-job") {
      const jobId = drawerButton.dataset.jobId;
      if (jobId) {
        const existingJob = state.jobs.find((item) => item.id === jobId);
        if (existingJob) showJobDetail(jobId);
        else {
          switchView("jobs");
          $("jobSearch").value = jobId;
          $("globalSearch").value = jobId;
          renderJobs();
          toast("已切到任务页，请在当前列表中查看关联任务", "info");
        }
      }
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

$("sensitiveWordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  try {
    await withBusy(button, "保存中", async () => {
      const response = await api("/api/admin/sensitive-words", {
        method: "POST",
        body: JSON.stringify({
          patterns: $("sensitiveWordPatterns").value,
          replace: $("sensitiveWordReplace").checked,
        }),
      });
      state.sensitiveRules = response.rules;
      appendAuditLog("risk.sensitive_words.configure", "sensitive_words", { imported: response.imported, replace: response.replace });
      $("sensitiveWordReplace").checked = false;
      renderRisk();
      renderNavCounts();
      toast(`已导入 ${response.imported} 条规则`, "success");
    });
  } catch (error) {
    toast(error.message, "error");
  }
});

$("clearSensitiveWordInput").addEventListener("click", () => {
  $("sensitiveWordPatterns").value = "";
  $("sensitiveWordPatterns").focus();
});

$("sensitiveWordRows").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest("tr");
  const id = row?.dataset.id;
  const rule = state.sensitiveRules.find((item) => item.id === id);
  if (!row || !rule) return;
  try {
    if (button.dataset.action === "save-sensitive-rule") {
      const name = row.querySelector("[data-field='rule-name']").value.trim();
      const pattern = row.querySelector("[data-field='rule-pattern']").value.trim();
      const response = await withBusy(button, "保存中", () => api(`/api/admin/sensitive-words/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, pattern }),
      }));
      upsertById(state.sensitiveRules, response.rule);
      appendAuditLog("risk.sensitive_word.update", id, { name, pattern });
      renderRisk();
      renderNavCounts();
      toast("规则已保存", "success");
      return;
    }
    if (button.dataset.action === "toggle-sensitive-rule") {
      const response = await withBusy(button, rule.enabled ? "停用中" : "启用中", () => api(`/api/admin/sensitive-words/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !rule.enabled }),
      }));
      upsertById(state.sensitiveRules, response.rule);
      appendAuditLog("risk.sensitive_word.update", id, { enabled: response.rule.enabled });
      renderRisk();
      renderNavCounts();
      toast(response.rule.enabled ? "规则已启用" : "规则已停用", "success");
      return;
    }
    if (button.dataset.action === "delete-sensitive-rule") {
      await withBusy(button, "删除中", () => api(`/api/admin/sensitive-words/${id}`, { method: "DELETE" }));
      state.sensitiveRules = state.sensitiveRules.filter((item) => item.id !== id);
      appendAuditLog("risk.sensitive_word.delete", id, {});
      renderRisk();
      renderNavCounts();
      toast("规则已删除", "success");
    }
  } catch (error) {
    toast(error.message, "error");
  }
});

$("riskAlertRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='detail-risk-alert']");
  if (!button) return;
  showRiskAlertDetail(button.closest("tr").dataset.id);
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
      data.batchCount = Number(data.batchCount || 1);
      if (data.batchCount > 1 && String(data.code || "").trim()) throw new Error("批量生成时请留空兑换码");
      data.expiresAt = isoFromLocal(data.expiresAt);
      const { code, codes } = await api("/api/admin/redemption-codes", { method: "POST", body: JSON.stringify(data) });
      const created = Array.isArray(codes) && codes.length ? codes : [code];
      form.reset();
      form.elements.batchCount.value = "1";
      form.elements.credits.value = data.credits || 100;
      form.elements.maxUses.value = data.maxUses || 1;
      state.codes.unshift(...created);
      appendAuditLog(created.length > 1 ? "redemption_code.batch_create" : "redemption_code.create", created[0].id, {
        count: created.length,
        codes: created.map((item) => item.code),
        activityKey: created[0].activityKey,
        credits: created[0].credits,
        maxUses: created[0].maxUses,
      });
      rerenderAfterMutation();
      showCreatedCodesPopover(created);
    });
    toast("兑换码已生成，可复制本次创建", "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("closeCodeBatchPopover").addEventListener("click", closeCreatedCodesPopover);
$("codeBatchScrim").addEventListener("click", closeCreatedCodesPopover);

$("copyCreatedCodes").addEventListener("click", async (event) => {
  try {
    if (!state.lastCreatedCodes.length) throw new Error("没有可复制的本次创建兑换码");
    await withBusy(event.currentTarget, "复制中", () => copyText(codeBatchText(false)));
    toast(`已复制 ${state.lastCreatedCodes.length} 个兑换码`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("copyCreatedCodesCsv").addEventListener("click", async (event) => {
  try {
    if (!state.lastCreatedCodes.length) throw new Error("没有可复制的本次创建兑换码");
    await withBusy(event.currentTarget, "复制中", () => copyText(codeBatchText(true)));
    toast(`已复制 ${state.lastCreatedCodes.length} 个兑换码明细`, "success");
  } catch (error) {
    toast(error.message, "error");
  }
});

$("codeRows").addEventListener("click", async (event) => {
  const copyButton = event.target.closest("button[data-action='copy-code']");
  if (copyButton) {
    try {
      const id = copyButton.closest("tr").dataset.id;
      const code = state.codes.find((item) => item.id === id);
      await copyText(code?.code || "");
      toast("兑换码已复制", "success");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }

  const deleteButton = event.target.closest("button[data-action='delete-code']");
  if (deleteButton) {
    try {
      const id = deleteButton.closest("tr").dataset.id;
      const code = state.codes.find((item) => item.id === id);
      const usedCount = (code?.usedBy || []).length;
      if (!code || usedCount === 0) throw new Error("只能删除已经使用过的兑换码");
      if (!window.confirm(`删除已使用兑换码 ${code.code}？历史兑换记录会保留。`)) return;
      await withBusy(deleteButton, "删除中", () => api(`/api/admin/redemption-codes/${id}`, { method: "DELETE" }));
      state.codes = state.codes.filter((item) => item.id !== id);
      appendAuditLog("redemption_code.delete", id, { code: code.code, activityKey: code.activityKey, usedCount });
      rerenderAfterMutation();
      toast("已使用兑换码已删除", "success");
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }

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

$("copyFilteredCodes").addEventListener("click", async (event) => {
  try {
    const codes = filteredCodes().map((code) => code.code);
    if (!codes.length) throw new Error("当前列表没有可复制的兑换码");
    await withBusy(event.currentTarget, "复制中", () => copyText(codes.join("\n")));
    toast(`已复制 ${codes.length} 个兑换码`, "success");
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
bindFilter("gallerySearch", renderGallery);
bindFilter("galleryStatusFilter", renderGallery);
bindFilter("riskSearch", renderRiskAlerts);
bindFilter("riskStatusFilter", renderRiskAlerts);
bindFilter("ruleSearch", renderSensitiveRules);
bindFilter("ruleStatusFilter", renderSensitiveRules);

$("exportErrorLogs").addEventListener("click", () => {
  const failed = state.jobs.filter((j) => j.status === "failed");
  if (!failed.length) { toast("没有失败任务", "info"); return; }
  const records = failed.map((j) => ({
    id: j.id,
    createdAt: j.createdAt,
    userEmail: j.userEmail,
    userId: j.userId,
    model: j.model,
    gatewayId: j.gatewayId,
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    retryCount: j.retryCount,
    latencyMs: j.latencyMs,
    prompt: j.prompt,
    size: j.size,
    quality: j.quality,
    network: {
      requestUrl: j.requestUrl ?? null,
      rawResponse: j.rawResponse ?? null,
    },
  }));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }));
  a.download = `error-logs-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
});
bindFilter("codeSearch", renderCodes);
bindFilter("codeStatusFilter", renderCodes);
bindFilter("auditSearch", renderAudit);

applyDensity();
applyShellState();
applyAutoRefresh();
switchView(state.view);
ensureAdmin();
