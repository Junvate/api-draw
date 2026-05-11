const STORAGE_KEYS = {
  draft: "draw.workspace.draft.v2",
  lastJobId: "draw.workspace.last-job.v2",
};

const PENDING_JOB_STATUSES = new Set(["queued", "running", "processing"]);
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed"]);
const POLL_INTERVALS = [1200, 1600, 2200, 2800, 3600, 5000];

const state = {
  user: null,
  settings: {},
  model: "gpt-image-2",
  subtitle: "gpt-image-2",
  type: "图像",
  ratio: "自动",
  quality: "高清(2k)",
  count: 1,
  refs: 0,
  jobs: [],
  previewUrls: [],
  referenceFiles: [],
  activeResultJob: null,
  activeJobId: null,
  activeImageIndex: 0,
  pollAttempt: 0,
  pollTimer: null,
  notifyOnJobFinish: false,
  promptPage: 0,
  jobStartTime: null,
};

const prompts = [
  "高端护肤品电商主图，一瓶精华液产品置于画面中心，透明玻璃瓶身，银色滴管，背景为浅米色大理石台面，柔和自然光从左上方照射，水滴、花瓣、透明质感凝胶点缀，整体干净高级，适合天猫京东主图，商业摄影风格，高清细节，真实产品质感，浅景深，简约奢华，8K，studio lighting",
  "高级口红礼盒电商广告图，三支口红竖立摆放在丝绒礼盒中，背景为酒红色与金色渐变，周围有玫瑰花瓣、金色丝带和柔和光斑，突出节日送礼氛围，画面精致浪漫，商业广告摄影，产品居中，质感清晰，高端美妆品牌风格，高清，luxury cosmetic advertising",
  "潮流运动鞋电商主图，一双白色科技感跑鞋悬浮在画面中心，背景为蓝白渐变科技空间，鞋底有轻微发光效果，周围有速度线、空气流动粒子和运动轨迹，突出轻盈、缓震、透气性能，商业级产品摄影，清晰鞋面纹理，干净构图，适合电商详情页首屏，ultra realistic, 8K",
  "冰咖啡饮品商业海报，一杯冰拿铁置于画面中心，透明塑料杯，咖啡与牛奶形成漂亮分层，冰块清晰可见，背景为浅棕色咖啡馆氛围，咖啡豆飞溅，奶泡与液体动态效果，夏日清爽感，适合外卖平台广告图，真实商业摄影，高级光影，高清细节",
  "高端家居香薰蜡烛电商图，香薰蜡烛和藤条香薰瓶摆放在木质桌面上，背景为温暖奶油色卧室场景，柔和阳光透过纱帘，旁边有干花、书本和亚麻布，突出治愈、放松、生活品质感，北欧极简风，商业产品摄影，温柔高级，高清真实质感",
  "健康坚果零食电商主图，一袋混合坚果包装放在画面中心，周围散落腰果、杏仁、核桃、蔓越莓干，背景为浅色木纹台面，阳光自然照射，突出健康、营养、每日坚果概念，画面干净明亮，适合淘宝京东食品主图，真实食品摄影，高清细节，色彩自然诱人",
  "高端茶叶礼盒商业广告图，深绿色茶叶礼盒打开摆放，里面整齐放置茶罐和茶包，背景为中式雅致茶室，竹影、茶烟、陶瓷茶具点缀，整体沉稳高级，国风东方美学，适合中秋春节礼品电商图，商业摄影，产品质感清晰，柔和暖光，高清",
  "智能手表电商科技主图，一块黑色智能手表悬浮在深蓝色科技背景中，屏幕显示健康数据、心率、运动轨迹，周围有蓝色HUD界面、数据光线和粒子效果，突出科技、健康、运动监测，画面简洁高端，适合数码产品广告，真实产品渲染，超清细节，8K",
  "车载无线吸尘器电商主图，黑色轻量化吸尘器斜向悬浮展示，背景为汽车内饰场景，座椅缝隙处有灰尘被吸走的动态效果，突出强吸力、无线便携、车家两用，画面干净专业，商业产品摄影，科技感灯光，高清细节，适合电商详情页",
  "春夏女装电商海报，一位模特穿着浅色连衣裙站在极简白色摄影棚中，背景有柔和花影和浅米色布景，整体清新、温柔、高级，突出面料轻盈、版型修身、日常通勤感，商业时尚摄影，杂志大片质感，高清人像，服装细节清晰，自然光影",
  "男士护肤套装电商广告图，洁面乳、爽肤水、面霜三件套整齐摆放在深灰色岩石台面上，背景为黑灰渐变，冷色灯光，水珠与冰感元素点缀，突出控油、清爽、干净、专业男士护理，商业摄影，高级质感，产品包装清晰，硬朗风格，8K",
  "儿童益智玩具电商主图，彩色积木和拼装玩具摆放在明亮儿童房地毯上，背景有柔和阳光、童趣墙面和收纳架，画面温暖活泼，突出安全材质、益智启蒙、亲子互动，产品居中清晰，适合母婴电商平台，真实商业摄影，高清细节，明亮色彩",
  "空气炸锅电商详情页首图，白色空气炸锅放置在现代厨房台面上，旁边有炸薯条、鸡翅、蔬菜和餐盘，背景为干净明亮的厨房空间，突出无油健康、快速烹饪、家庭实用，商业产品摄影，真实光影，产品外观高级，高清细节，适合家电主图",
  "宠物猫粮电商广告图，一袋高级猫粮包装置于画面中心，旁边有可爱的猫咪、猫粮颗粒、鱼肉和鸡肉食材展示，背景为温暖浅色家居环境，突出天然、营养、健康、适口性好，商业摄影风格，画面干净亲和，宠物表情自然，高清细节",
  "高端香水电商广告图，一瓶透明香水置于镜面水台中央，背景为淡粉色和香槟金渐变，周围有花瓣、水波纹、柔和雾气和光影折射，突出优雅、浪漫、精致香氛氛围，奢侈品商业摄影，玻璃质感真实，构图高级，高清8K",
  "户外露营装备电商广告图，帐篷、折叠椅、露营灯、野餐桌摆放在湖边草地上，远处有山脉和落日，氛围温暖自由，突出户外、轻便、家庭露营、周末旅行，商业摄影，真实自然风光，产品清晰可见，电影感光影，高清",
  "高级珠宝项链电商主图，一条金色项链摆放在浅米色丝绸布面上，旁边有珍珠、花瓣和柔和阴影，背景干净简约，突出精致、轻奢、送礼、高级感，商业珠宝摄影，金属反光真实，细节清晰，浅景深，奢侈品广告风格，8K",
  "洗发水护发素家庭装电商图，两瓶洗护产品放在浴室大理石台面上，背景为明亮高级浴室，水珠、泡沫、植物叶片点缀，突出柔顺、滋养、清洁、清香感，商业摄影，产品包装清晰，白色干净背景，高级生活方式广告图，高清真实",
  "新鲜水果礼盒电商主图，礼盒中整齐摆放橙子、苹果、猕猴桃、葡萄和草莓，水果表面有自然水珠，背景为浅色木桌和柔和阳光，突出新鲜、产地直发、健康送礼，食品商业摄影，色彩自然饱满，画面干净诱人，高清细节",
  "无线蓝牙耳机电商科技广告图，一副白色真无线耳机悬浮在深蓝渐变背景中，耳机周围有声波线条、蓝色粒子和动态光效，突出降噪、高清音质、长续航、轻便佩戴，商业级产品渲染，科技感强，产品细节清晰，适合电商主图和详情页，8K",
];

const $ = (id) => document.getElementById(id);
const modelOptions = document.querySelectorAll(".model-option");
const ratioOptions = document.querySelectorAll(".tile");
const qualityOptions = document.querySelectorAll("#qualityOptions .quality");
const countOptions = document.querySelectorAll("#countOptions .quality");
const switcherButtons = document.querySelectorAll(".switcher button");
const promptForm = $("promptForm");
const promptInput = $("promptInput");
const emptyState = $("emptyState");
const resultCard = $("resultCard");
const resultArt = $("resultArt");
const stageThumbs = $("stageThumbs");
const resultTitle = $("resultTitle");
const resultPrompt = $("resultPrompt");
const resultActions = $("resultActions");
const expiryNotice = $("expiryNotice");
const resultEdit = $("resultEdit");
const resultOpen = $("resultOpen");
const resultDownload = $("resultDownload");
const stageActions = $("stageActions");
const stageEdit = $("stageEdit");
const stageOpen = $("stageOpen");
const stageDownload = $("stageDownload");
const canvasStage = $("canvasStage");
const imageUpload = $("imageUpload");
const referenceTray = $("referenceTray");
const clearReferences = $("clearReferences");
const authDialog = $("authDialog");
const captchaImage = $("captchaImage");
const authCaptchaId = $("authCaptchaId");
const authCaptchaCode = $("authCaptchaCode");
let authMode = "login";
const promptCounter = $("promptCounter");
const composerToggle = $("composerToggle");
const composerRail = $("composerRail");
const creationLayout = promptForm;

async function api(path, options = {}) {
  const headers = options.headers === undefined
    ? { "Content-Type": "application/json" }
    : options.headers;
  const response = await fetch(path, {
    headers,
    credentials: "same-origin",
    cache: "no-store",
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || "请求失败");
  return payload;
}

function setActive(items, selected, { animate = true } = {}) {
  if (!selected) return;
  items.forEach((item) => item.classList.toggle("active", item === selected));
  if (animate && typeof selected.animate === "function") {
    selected.animate([{ transform: "scale(0.985)" }, { transform: "scale(1)" }], { duration: 160, easing: "ease-out" });
  }
}

function money(cents) {
  return `¥${(cents / 100).toFixed(0)}`;
}

function estimateCost() {
  const unit = state.quality === "超清(4k)" ? 8 : 6;
  return unit * (state.count || 1);
}

function isPendingStatus(status) {
  return PENDING_JOB_STATUSES.has(status);
}

function isTerminalStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function resolveResultUrl(job) {
  return job?.displayUrl || job?.display_url || job?.resultUrl || job?.result_url || job?.images?.[0]?.url || null;
}

function normalizeResultImages(job) {
  const rawImages = Array.isArray(job?.images) ? job.images : [];
  const images = rawImages
    .map((img, index) => {
      if (!img) return null;
      const suffix = index > 0 ? `?i=${index}` : "";
      const displayUrl = img.display_url || img.displayUrl || (job?.id ? `/api/images/${job.id}/result${suffix}` : null) || img.url || null;
      const originalUrl = img.url || displayUrl;
      const downloadUrl = img.download_url || img.downloadUrl || (job?.id ? `/api/images/${job.id}/download${suffix}` : null);
      const thumbUrl = img.thumbnail_url || img.thumbnailUrl || displayUrl || originalUrl;
      if (!displayUrl && !originalUrl) return null;
      return { displayUrl, originalUrl, downloadUrl, thumbUrl };
    })
    .filter(Boolean);

  if (!images.length) {
    const displayUrl = job?.displayUrl || job?.display_url || null;
    const originalUrl = job?.resultUrl || job?.result_url || displayUrl;
    if (displayUrl || originalUrl) {
      images.push({
        displayUrl: displayUrl || originalUrl,
        originalUrl,
        downloadUrl: resolveDownloadUrl(job),
        thumbUrl: displayUrl || originalUrl,
      });
    }
  }

  return images;
}

function activeResultImage(job) {
  const images = normalizeResultImages(job);
  if (!images.length) return null;
  const index = Math.min(Math.max(state.activeImageIndex, 0), images.length - 1);
  return images[index];
}

function resolveOriginalResultUrl(job) {
  return job?.resultUrl || job?.result_url || job?.images?.[0]?.url || resolveResultUrl(job);
}

function resolveDownloadUrl(job) {
  return job?.downloadUrl || job?.download_url || (job?.id ? `/api/images/${job.id}/download` : null);
}

function cacheBustResultUrl(url, job) {
  if (!url || !url.startsWith("/api/images/")) return url;
  const token = encodeURIComponent(job?.completedAt || job?.completed_at || job?.updatedAt || job?.updated_at || Date.now());
  return `${url}${url.includes("?") ? "&" : "?"}v=${token}`;
}

function clipText(value, max = 84) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function rememberActiveJob(taskId) {
  state.activeJobId = taskId || null;
  try {
    if (taskId) localStorage.setItem(STORAGE_KEYS.lastJobId, taskId);
    else localStorage.removeItem(STORAGE_KEYS.lastJobId);
  } catch {}
}

function stopJobPolling({ clearRemembered = false } = {}) {
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollAttempt = 0;
  state.notifyOnJobFinish = false;
  if (clearRemembered) rememberActiveJob(null);
}

function scheduleJobPoll() {
  if (!state.activeJobId) return;
  const delay = POLL_INTERVALS[Math.min(state.pollAttempt, POLL_INTERVALS.length - 1)];
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(() => pollActiveJob(), delay);
}

function clearThumbPreviews() {
  state.previewUrls.forEach((url) => URL.revokeObjectURL(url));
  state.previewUrls = [];
  state.referenceFiles = [];
  state.refs = 0;
  imageUpload.value = "";
  referenceTray.replaceChildren();
  referenceTray.classList.add("hidden");
  clearReferences.classList.add("hidden");
  updateTask();
  persistWorkspaceState();
}

function renderReferencePreviews(files) {
  referenceTray.replaceChildren();
  referenceTray.classList.toggle("hidden", !files.length);
  clearReferences.classList.toggle("hidden", !files.length);
  files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const item = document.createElement("div");
    item.className = "reference-item";
    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name || `本次参考图 ${index + 1}`;
    img.title = file.name || "本次参考图";
    const badge = document.createElement("span");
    badge.textContent = `参考图 ${index + 1}`;
    item.append(img, badge);
    referenceTray.appendChild(item);
  });
}

function extensionForImageType(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "png";
}

async function addResultAsReference(job) {
  const currentImage = activeResultImage(job);
  const resultUrl = currentImage?.displayUrl || currentImage?.originalUrl || resolveResultUrl(job);
  if (!job || !resultUrl) throw new Error("当前没有可继续编辑的图片");
  const response = await fetch(resultUrl, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("读取当前图片失败，请先打开结果确认图片可访问");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("当前结果不是可编辑的图片格式");
  const filename = `edit-${job.id || Date.now()}.${extensionForImageType(blob.type)}`;
  clearThumbPreviews();
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  state.referenceFiles = [file];
  state.refs = 1;
  renderReferencePreviews(state.referenceFiles);
  updateTask();
  persistWorkspaceState();
}

function createGeneratePayload(prompt) {
  const payload = {
    prompt,
    model: state.model,
    ratio: state.ratio,
    quality: state.quality,
    count: state.count,
    refs: state.refs,
    response_mode: "async",
  };
  if (!state.referenceFiles.length) {
    return {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    };
  }
  const body = new FormData();
  Object.entries(payload).forEach(([key, value]) => body.append(key, String(value)));
  state.referenceFiles.forEach((file) => body.append("image", file, file.name));
  return { body, headers: {} };
}

function persistWorkspaceState() {
  try {
    localStorage.setItem(STORAGE_KEYS.draft, JSON.stringify({
      prompt: promptInput.value,
      ratio: state.ratio,
      quality: state.quality,
      model: state.model,
      subtitle: state.subtitle,
      type: state.type,
      composerCollapsed: creationLayout.classList.contains("sidebar-collapsed"),
    }));
  } catch {}
}

function restoreWorkspaceState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.draft);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (typeof draft.prompt === "string") promptInput.value = draft.prompt;

    const storedRatio = draft.ratio === "自动" ? "Auto" : draft.ratio;
    const ratioButton = Array.from(ratioOptions).find((button) => button.dataset.value === storedRatio);
    if (ratioButton) {
      setActive(ratioOptions, ratioButton, { animate: false });
      state.ratio = ratioButton.dataset.value === "Auto" ? "自动" : ratioButton.dataset.value;
    }

    const qualityButton = Array.from(qualityOptions).find((button) => button.dataset.value === draft.quality);
    if (qualityButton) {
      setActive(qualityOptions, qualityButton, { animate: false });
      state.quality = qualityButton.dataset.value;
    }

    const modelButton = Array.from(modelOptions).find((button) => button.dataset.model === draft.model);
    if (modelButton) {
      setActive(modelOptions, modelButton, { animate: false });
      state.model = modelButton.dataset.model;
      state.subtitle = modelButton.dataset.subtitle || state.subtitle;
      state.type = modelButton.classList.contains("video") ? "视频" : "图像";
    }

    setComposerCollapsed(Boolean(draft.composerCollapsed));
  } catch {}
}

function updateAccount(user) {
  state.user = user;
  $("accountName").textContent = user ? user.name : "未登录";
  $("creditBalance").textContent = user ? user.credits : "0";
  $("loginButton").classList.toggle("hidden", Boolean(user));
  $("logoutButton").classList.toggle("hidden", !user);
  const buyBtn = $("buyCreditsBtn");
  if (buyBtn) buyBtn.classList.toggle("hidden", !user || !state.settings.buy_credits_url);
  $("adminCard").classList.toggle("hidden", user?.role !== "admin");
  if (!user) {
    $("adminSummary").textContent = "";
    $("gatewayList").replaceChildren();
  }
  document.dispatchEvent(new CustomEvent("accountUpdated", { detail: user }));
}

function updateTask() {
  $("briefSpec").textContent = `${state.ratio} · ${state.quality}`;
  $("briefCost").textContent = `${estimateCost()} 积分`;
  $("taskModel").textContent = state.model;
  $("taskType").textContent = state.type;
  $("taskRatio").textContent = state.ratio;
  $("taskRefs").textContent = `${state.refs}/3`;
}

function updatePromptCounter() {
  const length = promptInput.value.length;
  promptCounter.textContent = `${length}/8000`;
  promptCounter.classList.toggle("warning", length >= 7000);
}

function renderPrompts(page = state.promptPage) {
  const list = $("suggestList");
  const pageSize = 4;
  const pageCount = Math.ceil(prompts.length / pageSize);
  const normalizedPage = ((page % pageCount) + pageCount) % pageCount;
  state.promptPage = normalizedPage;
  const offset = normalizedPage * pageSize;
  list.replaceChildren();
  prompts.slice(offset, offset + 4).forEach((prompt) => {
    const button = document.createElement("button");
    button.className = "suggest-item";
    button.type = "button";
    button.textContent = prompt.length > 72 ? `${prompt.slice(0, 72)}...` : prompt;
    button.addEventListener("click", () => {
      promptInput.value = prompt;
      updatePromptCounter();
      persistWorkspaceState();
      promptInput.focus();
      showToast("提示词已填入输入框");
    });
    list.appendChild(button);
  });
}

function formatJobTitle(status) {
  return {
    queued: "等待处理",
    running: "正在生成",
    processing: "正在生成",
    succeeded: "生成成功",
    failed: "生成失败",
  }[status] || String(status || "任务状态");
}

function formatResultHeadline(status) {
  return {
    queued: "任务已进入队列",
    running: "图像正在生成",
    processing: "图像正在生成",
    succeeded: "生成完成",
    failed: "生成失败",
  }[status] || "结果预览";
}

function formatResultMessage(job) {
  if (!job) return "提交任务后，生成结果会显示在这里。";
  if (job.status === "queued") return "系统已保存这次创作请求，正在等待可用通道处理。";
  if (job.status === "running" || job.status === "processing") return "图像正在生成中，通常几秒内会返回结果。";
  if (job.status === "failed") return job.error || "这次生成未成功完成，建议调整提示词后重试。";
  return job.prompt ? clipText(job.prompt, 96) : "已根据当前提示词生成预览图。";
}

function updateResultActions(resultUrl, downloadUrl, isRemoteUrl, canEdit = false) {
  const visible = Boolean(resultUrl);
  resultActions.classList.toggle("hidden", !visible);
  stageActions.classList.toggle("hidden", !visible);
  expiryNotice.classList.toggle("hidden", !visible || !isRemoteUrl);
  resultEdit.classList.toggle("hidden", !visible || !canEdit);
  stageEdit.classList.toggle("hidden", !visible || !canEdit);
  if (visible) resultOpen.href = resultUrl;
  else resultOpen.removeAttribute("href");
  if (visible) stageOpen.href = resultUrl;
  else stageOpen.removeAttribute("href");
  if (visible && downloadUrl) resultDownload.href = downloadUrl;
  else resultDownload.removeAttribute("href");
  if (visible && downloadUrl) stageDownload.href = downloadUrl;
  else stageDownload.removeAttribute("href");
}

function createResultPlaceholder(job) {
  const wrapper = document.createElement("div");
  wrapper.className = `result-placeholder ${job.status || "idle"}`;
  wrapper.setAttribute("role", job.status === "failed" ? "alert" : "status");

  const badge = document.createElement("span");
  badge.className = `result-status-badge ${job.status || "idle"}`;
  badge.textContent = formatJobTitle(job.status);

  const spinner = document.createElement("span");
  spinner.className = "result-spinner";
  spinner.setAttribute("aria-hidden", "true");
  if (job.status === "failed") spinner.classList.add("hidden");

  const title = document.createElement("strong");
  title.textContent = formatResultHeadline(job.status);

  const message = document.createElement("p");
  message.textContent = formatResultMessage(job);

  wrapper.append(badge, spinner, title, message);

  if (isPendingStatus(job.status)) {
    const progressWrap = document.createElement("div");
    progressWrap.className = "gen-progress-wrap";
    const progressBar = document.createElement("div");
    progressBar.className = "gen-progress-bar";
    const elapsed = state.jobStartTime ? (Date.now() - state.jobStartTime) / 1000 : 0;
    const pct = Math.min(90, Math.round(elapsed / 25 * 90));
    progressBar.style.width = `${pct}%`;
    const progressLabel = document.createElement("span");
    progressLabel.className = "gen-progress-label";
    progressLabel.textContent = `${pct}%`;
    progressWrap.append(progressBar);
    wrapper.append(progressWrap, progressLabel);
  }

  if (job.prompt) {
    const prompt = document.createElement("small");
    prompt.textContent = `提示词：${clipText(job.prompt, 60)}`;
    wrapper.appendChild(prompt);
  }

  return wrapper;
}

function renderResultCard(job, { silent = false } = {}) {
  const images = normalizeResultImages(job);
  const imageCount = images.length;
  const nextJobId = job?.id || null;
  if (state.activeResultJob?.id !== nextJobId) state.activeImageIndex = 0;
  if (state.activeImageIndex >= Math.max(1, imageCount)) state.activeImageIndex = 0;
  const activeIndex = state.activeImageIndex;
  const activeImage = images[activeIndex] || null;

  const resultUrl = activeImage?.displayUrl || resolveResultUrl(job);
  const displayResultUrl = cacheBustResultUrl(resultUrl, job);
  const originalUrl = activeImage?.originalUrl || resolveOriginalResultUrl(job);
  const downloadUrl = activeImage?.downloadUrl || resolveDownloadUrl(job);
  const canEdit = Boolean(resultUrl && job?.status === "succeeded");
  state.activeResultJob = canEdit ? job : null;
  emptyState.classList.add("hidden");
  resultCard.classList.remove("hidden");
  canvasStage.classList.toggle("has-result", Boolean(resultUrl));
  resultCard.style.display = "block";
  resultCard.dataset.status = job?.status || "idle";
  resultArt.replaceChildren();
  canvasStage.querySelector(".stage-result-image")?.remove();

  if (displayResultUrl) {
    canvasStage.style.setProperty("--stage-result-url", `url("${displayResultUrl}")`);
    const stageImage = document.createElement("img");
    stageImage.className = "stage-result-image";
    stageImage.src = displayResultUrl;
    stageImage.alt = imageCount > 1 ? `生成结果 ${activeIndex + 1} / ${imageCount}` : "生成结果";
    stageImage.referrerPolicy = "no-referrer";
    canvasStage.appendChild(stageImage);

    const image = document.createElement("img");
    image.src = displayResultUrl;
    image.alt = imageCount > 1 ? `生成结果 ${activeIndex + 1} / ${imageCount}` : "生成结果";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      resultArt.replaceChildren(createResultPlaceholder({
        ...job,
        status: "failed",
        error: "图片结果已生成，但浏览器加载图片失败。请点击打开原图查看。",
      }));
    }, { once: true });
    image.addEventListener("load", () => {
      canvasStage.classList.add("has-loaded-result");
    }, { once: true });
    resultArt.appendChild(image);
  } else {
    canvasStage.style.removeProperty("--stage-result-url");
    canvasStage.classList.remove("has-loaded-result");
    resultArt.appendChild(createResultPlaceholder(job || { status: "queued" }));
  }

  renderStageThumbs(job, images, activeIndex);

  resultTitle.textContent = formatResultHeadline(job?.status);
  resultPrompt.textContent = formatResultMessage(job);
  updateResultActions(originalUrl || resultUrl, downloadUrl, Boolean(job?.resultUrl || job?.result_url || originalUrl), canEdit);
  if (!silent) showToast("预览已更新");
}

function renderStageThumbs(job, images, activeIndex) {
  if (!stageThumbs) return;
  if (!images || images.length <= 1) {
    canvasStage.classList.remove("has-stage-thumbs");
    stageThumbs.classList.add("hidden");
    stageThumbs.replaceChildren();
    return;
  }
  canvasStage.classList.add("has-stage-thumbs");
  stageThumbs.classList.remove("hidden");
  stageThumbs.replaceChildren();
  images.forEach((img, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `stage-thumb${index === activeIndex ? " active" : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(index === activeIndex));
    btn.title = `第 ${index + 1} 张`;
    const thumbImg = document.createElement("img");
    thumbImg.src = cacheBustResultUrl(img.thumbUrl || img.displayUrl || img.originalUrl, job);
    thumbImg.alt = `结果缩略图 ${index + 1}`;
    thumbImg.referrerPolicy = "no-referrer";
    btn.appendChild(thumbImg);
    const label = document.createElement("span");
    label.className = "stage-thumb-index";
    label.textContent = String(index + 1);
    btn.appendChild(label);
    btn.addEventListener("click", () => {
      if (state.activeImageIndex === index) return;
      state.activeImageIndex = index;
      renderResultCard(job, { silent: true });
    });
    stageThumbs.appendChild(btn);
  });
}

function resetResultStage() {
  stopJobPolling({ clearRemembered: true });
  resultCard.classList.add("hidden");
  canvasStage.classList.remove("has-result", "has-loaded-result");
  canvasStage.style.removeProperty("--stage-result-url");
  canvasStage.querySelector(".stage-result-image")?.remove();
  resultCard.dataset.status = "idle";
  resultArt.replaceChildren();
  canvasStage.classList.remove("has-stage-thumbs");
  if (stageThumbs) {
    stageThumbs.classList.add("hidden");
    stageThumbs.replaceChildren();
  }
  resultTitle.textContent = "生成完成";
  resultPrompt.textContent = "已根据当前提示词生成预览图。";
  state.activeResultJob = null;
  state.activeImageIndex = 0;
  updateResultActions(null);
  emptyState.classList.remove("hidden");
}

function upsertJob(job) {
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) state.jobs.splice(index, 1, { ...state.jobs[index], ...job });
  else state.jobs.unshift(job);
}

function normalizeJobs(jobs) {
  return [...jobs].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function renderJobs(jobs) {
  state.jobs = normalizeJobs(jobs);
  const list = $("jobList");
  list.replaceChildren();

  if (!state.jobs.length) {
    const empty = document.createElement("div");
    empty.className = "gateway-item";
    const label = document.createElement("span");
    label.textContent = "暂无生成历史";
    empty.appendChild(label);
    list.appendChild(empty);
    return;
  }

  state.jobs.forEach((job) => {
    const button = document.createElement("button");
    button.className = "gateway-item job-item";
    button.type = "button";
    if (job.id === state.activeJobId) button.classList.add("is-active");
    if (isPendingStatus(job.status)) button.classList.add("is-pending");

    const resultUrl = resolveResultUrl(job);
    if (resultUrl) {
      const thumb = document.createElement("img");
      thumb.className = "job-thumb";
      thumb.src = resultUrl;
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.referrerPolicy = "no-referrer";
      button.appendChild(thumb);
    }

    const title = document.createElement("strong");
    title.textContent = formatJobTitle(job.status);

    const meta = document.createElement("span");
    const owner = job.ownerName || job.ownerEmail;
    meta.textContent = `${job.model} · ${job.costCredits} 积分 · ${new Date(job.createdAt).toLocaleString()}${owner && !job.ownedByMe ? ` · ${owner}` : ""}`;

    button.append(title, meta);

    if (job.status === "failed" && job.error) {
      const hint = document.createElement("small");
      hint.textContent = clipText(job.error, 42);
      button.appendChild(hint);
    }

    button.addEventListener("click", () => {
      if (isPendingStatus(job.status)) {
        renderResultCard(job, { silent: true });
        startJobPolling(job.id, { showCompletionToast: false });
      } else {
        renderResultCard(job, { silent: true });
      }
      showToast("已载入所选任务");
    });

    list.appendChild(button);
  });

  const activeJob = state.jobs.find((job) => job.id === state.activeJobId);
  const latestResult = state.jobs.find((job) => resolveResultUrl(job));
  if (latestResult && !isPendingStatus(activeJob?.status)) {
    renderResultCard(latestResult, { silent: true });
  }
}

function renderGateways(gateways) {
  const list = $("gatewayList");
  list.replaceChildren();
  gateways.forEach((gateway) => {
    const card = document.createElement("div");
    card.className = "gateway-item";

    const title = document.createElement("strong");
    title.textContent = gateway.name;

    const meta = document.createElement("span");
    meta.textContent = `${gateway.provider} · ${gateway.model} · ${gateway.enabled ? "启用" : "停用"} · 优先级 ${gateway.priority}`;

    card.append(title, meta);
    list.appendChild(card);
  });
}

function showNotice(message) {
  showToast(message, "error");
}

function showToast(message, type = "info") {
  const stack = $("toastStack");
  if (typeof stack.showPopover === "function" && !stack.matches(":popover-open")) {
    try { stack.showPopover(); } catch {}
  }
  while (stack.children.length >= 3) stack.firstElementChild?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => {
    if (!toast.isConnected) return;
    const animation = typeof toast.animate === "function"
      ? toast.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { duration: 180, easing: "ease-in" })
      : null;
    const removeToast = () => {
      toast.remove();
      if (!stack.children.length && typeof stack.hidePopover === "function" && stack.matches(":popover-open")) {
        try { stack.hidePopover(); } catch {}
      }
    };
    if (animation) animation.onfinish = removeToast;
    else removeToast();
  }, type === "error" ? 4200 : 2600);
}

function setButtonLoading(button, loading, label) {
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
  if (loading) {
    button.dataset.label = button.innerHTML;
    button.textContent = label || "处理中";
  } else if (button.dataset.label) {
    button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }
}

async function refreshMe() {
  try {
    const { user } = await api("/api/me");
    if (!user) {
      updateAccount(null);
      renderJobs([]);
      resetResultStage();
      return null;
    }
    updateAccount(user);
    if (user?.role === "admin") await loadAdmin({ silent: true });
    return user;
  } catch {
    updateAccount(null);
    renderJobs([]);
    resetResultStage();
    return null;
  }
}

async function refreshJobs({ silent = false } = {}) {
  if (!state.user) {
    renderJobs([]);
    return [];
  }
  try {
    const { jobs } = await api(`/api/jobs?t=${Date.now()}`);
    renderJobs(jobs);
    return state.jobs;
  } catch (error) {
    if (!silent) showToast(error.message, "error");
    return state.jobs;
  }
}

async function fetchJob(taskId) {
  const { job } = await api(`/api/jobs/${taskId}`);
  return job;
}

async function loadAdmin({ silent = false } = {}) {
  if (state.user?.role !== "admin") return null;
  try {
    const [summary, gatewayData] = await Promise.all([api("/api/admin/summary"), api("/api/admin/gateways")]);
    $("adminSummary").textContent = `用户 ${summary.users} · 订单 ${summary.orders} · 收入 ${money(summary.paidRevenueCents)} · 任务 ${summary.jobs}`;
    renderGateways(gatewayData.gateways);
    return { summary, gateways: gatewayData.gateways };
  } catch (error) {
    if (!silent) showToast(error.message, "error");
    return null;
  }
}

async function loginOrRegister(path) {
  const isRegister = path.includes("register");
  if (isRegister && $("authPassword").value !== $("authPasswordConfirm").value) {
    $("authPasswordConfirm").focus();
    throw new Error("两次输入的密码不一致");
  }
  const payload = {
    email: $("authEmail").value.trim(),
    password: $("authPassword").value,
    passwordConfirm: $("authPasswordConfirm").value,
    name: $("authName").value.trim(),
  };
  if (isRegister) {
    payload.captchaId = authCaptchaId.value;
    payload.captchaCode = authCaptchaCode.value.trim();
  }
  const { user } = await api(path, { method: "POST", body: JSON.stringify(payload) });
  updateAccount(user);
  authDialog.close();
  showToast(isRegister ? "注册成功，已发放新用户积分" : "登录成功");
  // 后台刷新，不阻塞 UI
  refreshJobs({ silent: true }).then((jobs) => {
    if (jobs) hydrateWorkspaceFromJobs(jobs, { preferLatest: true });
  });
  loadAdmin({ silent: true });
}

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  const isRegister = authMode === "register";
  $("authTitle").textContent = isRegister ? "注册账号" : "登录平台";
  $("authDescription").textContent = isRegister ? "注册需要填写重复密码和 4 位验证码。" : "";
  $("authDescription").classList.toggle("hidden", !isRegister);
  $("authSubmitButton").textContent = isRegister ? "注册" : "登录";
  $("authLoginMode").classList.toggle("active", !isRegister);
  $("authRegisterMode").classList.toggle("active", isRegister);
  $("authLoginMode").setAttribute("aria-selected", String(!isRegister));
  $("authRegisterMode").setAttribute("aria-selected", String(isRegister));
  document.querySelectorAll(".register-only").forEach((item) => item.classList.toggle("hidden", !isRegister));
  $("authPassword").autocomplete = isRegister ? "new-password" : "current-password";
  $("authPasswordConfirm").required = isRegister;
  authCaptchaCode.required = isRegister;
  if (isRegister && !authCaptchaId.value) refreshCaptcha();
}

async function refreshCaptcha() {
  try {
    const captcha = await api(`/api/auth/captcha?t=${Date.now()}`);
    authCaptchaId.value = captcha.id || "";
    authCaptchaCode.value = "";
    captchaImage.src = captcha.image || "";
  } catch (error) {
    showToast(error.message || "验证码加载失败", "error");
  }
}

function hydrateWorkspaceFromJobs(jobs, { preferLatest = false } = {}) {
  if (!jobs.length) {
    if (!state.activeJobId) resetResultStage();
    return;
  }

  const remembered = (() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.lastJobId);
    } catch {
      return null;
    }
  })();

  const latestResult = jobs.find((job) => resolveResultUrl(job));
  const pending = jobs.find((job) => job.id === remembered && isPendingStatus(job.status))
    || (!latestResult ? jobs.find((job) => isPendingStatus(job.status)) : null);

  if (pending) {
    renderResultCard(pending, { silent: true });
    startJobPolling(pending.id, { showCompletionToast: false });
    return;
  }

  if (preferLatest || resultCard.classList.contains("hidden") || !resolveResultUrl(state.jobs.find((job) => job.id === state.activeJobId))) {
    const latest = latestResult || jobs.find((job) => job.status === "failed");
    if (latest) renderResultCard(latest, { silent: true });
  }
}

function startJobPolling(taskId, { showCompletionToast = true, isNew = false } = {}) {
  rememberActiveJob(taskId);
  state.pollAttempt = 0;
  state.notifyOnJobFinish = showCompletionToast;
  if (isNew) state.jobStartTime = Date.now();
  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  pollActiveJob();
}

async function pollActiveJob() {
  if (!state.activeJobId || !state.user) return;
  try {
    const job = await fetchJob(state.activeJobId);
    upsertJob(job);
    renderJobs(state.jobs);
    renderResultCard(job, { silent: true });

    if (isTerminalStatus(job.status)) {
      const shouldNotify = state.notifyOnJobFinish;
      state.jobStartTime = null;
      stopJobPolling({ clearRemembered: true });
      const jobs = await refreshJobs({ silent: true });
      upsertJob(job);
      renderJobs(state.jobs);
      renderResultCard(job, { silent: true });
      hydrateWorkspaceFromJobs(jobs, { preferLatest: true });
      if (shouldNotify) {
        showToast(job.status === "succeeded" ? "图片生成完成" : (job.error || "图片生成失败"), job.status === "failed" ? "error" : "info");
      }
      return;
    }

    state.pollAttempt += 1;
    scheduleJobPoll();
  } catch (error) {
    state.pollAttempt += 1;
    if (state.pollAttempt >= POLL_INTERVALS.length + 2) {
      stopJobPolling();
      showToast(`任务状态刷新失败：${error.message}`, "error");
      return;
    }
    scheduleJobPoll();
  }
}

modelOptions.forEach((button) => {
  button.addEventListener("click", () => {
    setActive(modelOptions, button);
    state.model = button.dataset.model;
    state.subtitle = button.dataset.subtitle;
    state.type = button.classList.contains("video") ? "视频" : "图像";
    updateTask();
    persistWorkspaceState();
  });
});

function enforceQualityRatioCompat() {
  const is4k = state.quality === "超清(4k)";
  const isSquare = state.ratio === "自动" || state.ratio === "1:1";
  if (is4k && isSquare) {
    state.quality = "高清(2k)";
    const btn = Array.from(qualityOptions).find((b) => b.dataset.value === "高清(2k)");
    if (btn) setActive(qualityOptions, btn, { animate: false });
    showToast("4K 仅支持 16:9 / 9:16，已自动切换为 2K", "info");
  }
}

ratioOptions.forEach((button) => {
  button.addEventListener("click", () => {
    setActive(ratioOptions, button);
    state.ratio = button.dataset.value === "Auto" ? "自动" : button.dataset.value;
    enforceQualityRatioCompat();
    updateTask();
    persistWorkspaceState();
  });
});

qualityOptions.forEach((button) => {
  button.addEventListener("click", () => {
    setActive(qualityOptions, button);
    state.quality = button.dataset.value;
    enforceQualityRatioCompat();
    updateTask();
    persistWorkspaceState();
  });
});

countOptions.forEach((button) => {
  button.addEventListener("click", () => {
    setActive(countOptions, button);
    state.count = parseInt(button.dataset.value, 10);
    updateTask();
    persistWorkspaceState();
  });
});

$("shufflePrompts").addEventListener("click", () => {
  renderPrompts(state.promptPage + 1);
});

$("negativeToggle").addEventListener("click", () => {
  const suffix = "\n\n反向提示词：低清晰度、畸形结构、文字错误、过度锐化、主体模糊";
  if (!promptInput.value.includes("反向提示词")) promptInput.value += suffix;
  updatePromptCounter();
  persistWorkspaceState();
  promptInput.focus();
  showToast("已添加反向提示词");
});

function setComposerCollapsed(collapsed) {
  creationLayout.classList.toggle("sidebar-collapsed", collapsed);
  composerToggle.textContent = collapsed ? "展开" : "收起";
  composerToggle.setAttribute("aria-expanded", String(!collapsed));
  persistWorkspaceState();
}

composerToggle.addEventListener("click", () => {
  setComposerCollapsed(!creationLayout.classList.contains("sidebar-collapsed"));
});

composerRail.addEventListener("click", () => {
  setComposerCollapsed(false);
  promptInput.focus();
});

promptInput.addEventListener("input", () => {
  updatePromptCounter();
  persistWorkspaceState();
});

promptInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    promptForm.requestSubmit();
  }
});

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.user) return openAuthDialog("请先登录后再生成图片");
  const prompt = promptInput.value.trim();
  if (prompt.length < 4) {
    promptInput.focus();
    return showToast("提示词至少输入 4 个字", "error");
  }

  const button = promptForm.querySelector(".generate-button");
  setButtonLoading(button, true, "提交中");
  showToast("任务已提交，正在进入生成队列");

  try {
    const payload = createGeneratePayload(prompt);
    const { job, credits } = await api("/api/generate", { method: "POST", ...payload });

    if (state.user) {
      state.user.credits = credits;
      updateAccount(state.user);
    }

    upsertJob({ ...job, prompt });
    renderJobs(state.jobs);
    renderResultCard({ ...job, prompt }, { silent: true });
    startJobPolling(job.id, { showCompletionToast: true, isNew: true });
    clearThumbPreviews();
    persistWorkspaceState();
  } catch (error) {
    showNotice(error.message);
  } finally {
    setButtonLoading(button, false);
  }
});

imageUpload.addEventListener("change", () => {
  const MAX = 10 * 1024 * 1024;
  const all = Array.from(imageUpload.files || []);
  const oversized = all.filter(f => f.size > MAX);
  if (oversized.length) {
    showToast(`图片过大（最大 10MB）：${oversized.map(f => f.name).join("、")}`, "error");
    imageUpload.value = "";
    return;
  }
  const files = all.slice(0, 3);
  clearThumbPreviews();
  state.referenceFiles = files;
  state.refs = files.length;
  renderReferencePreviews(files);

  updateTask();
  persistWorkspaceState();
  showToast(files.length ? `本次生成将参考 ${files.length} 张图片` : "已清空本次参考图");
});

clearReferences.addEventListener("click", () => {
  clearThumbPreviews();
  showToast("已清空本次参考图");
});

async function continueEditingActiveResult(button) {
  const job = state.activeResultJob;
  if (!job) return showToast("当前没有可继续编辑的图片", "error");
  setButtonLoading(button, true, "正在载入图片…");
  try {
    await addResultAsReference(job);
    setComposerCollapsed(false);
    promptInput.value = "";
    updatePromptCounter();
    persistWorkspaceState();
    promptInput.focus();
    showToast("已载入，请输入修改要求后生成");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
}

resultEdit.addEventListener("click", (event) => continueEditingActiveResult(event.currentTarget));
stageEdit.addEventListener("click", (event) => continueEditingActiveResult(event.currentTarget));

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const isRegister = authMode === "register";
  setButtonLoading(button, true, isRegister ? "注册中" : "登录中");
  try {
    await loginOrRegister(isRegister ? "/api/auth/register" : "/api/auth/login");
  } catch (error) {
    showToast(error.message, "error");
    if (isRegister) refreshCaptcha();
  } finally {
    setButtonLoading(button, false);
  }
});

function openAuthDialog(reason) {
  if (reason) showToast(reason, "error");
  setAuthMode("login");
  if (!authDialog.open) authDialog.showModal();
}

$("loginButton").addEventListener("click", () => openAuthDialog());
$("closeAuth").addEventListener("click", () => authDialog.close());
$("authLoginMode").addEventListener("click", () => setAuthMode("login"));
$("authRegisterMode").addEventListener("click", () => setAuthMode("register"));
$("refreshCaptcha").addEventListener("click", refreshCaptcha);
authDialog.addEventListener("click", (event) => {
  const rect = authDialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) authDialog.close();
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    updateAccount(null);
    renderJobs([]);
    resetResultStage();
    showToast("已退出登录");
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("refreshAccount").addEventListener("click", async (event) => {
  setButtonLoading(event.currentTarget, true, "刷新中");
  try {
    await refreshMe();
    showToast("账号信息已刷新");
  } finally {
    setButtonLoading(event.currentTarget, false);
  }
});

$("refreshJobs").addEventListener("click", async (event) => {
  setButtonLoading(event.currentTarget, true, "刷新中");
  try {
    const jobs = await refreshJobs();
    if (jobs.length) hydrateWorkspaceFromJobs(jobs, { preferLatest: true });
    showToast("生成历史已刷新");
  } finally {
    setButtonLoading(event.currentTarget, false);
  }
});

$("loadAdmin").addEventListener("click", async (event) => {
  setButtonLoading(event.currentTarget, true, "加载中");
  try {
    await loadAdmin();
    showToast("管理员数据已更新");
  } finally {
    setButtonLoading(event.currentTarget, false);
  }
});

$("workspaceTab").addEventListener("click", () => {
  setActive(switcherButtons, $("workspaceTab"));
  $("creditsView").classList.add("hidden");
  document.querySelector(".studio-panel").classList.remove("hidden");
  document.querySelector(".assistant-panel").classList.remove("hidden");
  promptInput.focus();
});

$("historyTab").addEventListener("click", async () => {
  if (!state.user) return openAuthDialog("登录后可查看生成历史");
  setActive(switcherButtons, $("historyTab"));
  $("creditsView").classList.add("hidden");
  document.querySelector(".studio-panel").classList.remove("hidden");
  document.querySelector(".assistant-panel").classList.remove("hidden");
  const jobs = await refreshJobs();
  if (jobs[0]) {
    renderResultCard(jobs[0], { silent: true });
    if (isPendingStatus(jobs[0].status)) startJobPolling(jobs[0].id, { showCompletionToast: false });
  }
  $("historyPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("creditsTab").addEventListener("click", () => {
  if (!state.user) return openAuthDialog("登录后可查看积分明细");
  setActive(switcherButtons, $("creditsTab"));
  document.querySelector(".studio-panel").classList.add("hidden");
  document.querySelector(".assistant-panel").classList.add("hidden");
  $("creditsView").classList.remove("hidden");
  window.creditsViewLoad(false);
});

$("creditStatusCard").addEventListener("click", () => $("creditsTab").click());
$("creditStatusCard").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("creditsTab").click();
  }
});

$("redeemForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const code = $("redeemCode").value.trim();
  if (!code) {
    $("redeemCode").focus();
    return showToast("请输入兑换码", "error");
  }
  if (!state.user) return openAuthDialog("请先登录后再兑换积分");
  setButtonLoading(button, true, "兑换中");
  try {
    const { credits, added } = await api("/api/redeem", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    state.user.credits = credits;
    updateAccount(state.user);
    $("redeemCode").value = "";
    showToast(`兑换成功，增加 ${added} 积分`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false);
  }
});

window.addEventListener("beforeunload", () => {
  clearThumbPreviews();
  stopJobPolling();
});

restoreWorkspaceState();
renderPrompts();
updateTask();
updatePromptCounter();
api("/api/settings").then((s) => {
  state.settings = s || {};
  const buyBtn = $("buyCreditsBtn");
  if (buyBtn && s?.buy_credits_url) buyBtn.href = s.buy_credits_url;
}).catch(() => {});
refreshMe().then(async (user) => {
  if (!user) return;
  const jobs = await refreshJobs({ silent: true });
  hydrateWorkspaceFromJobs(jobs, { preferLatest: true });
});

// ── 积分明细抽屉 ──────────────────────────────────────────────
(function () {
  const REASON_LABEL = {
    seed: "初始赠送", signup_bonus: "注册赠送", admin_adjust: "管理员调整",
    generation_hold: "生成扣费", generation_refund: "生成退款",
    generation_settle: "生成结算", redeem_code: "兑换码", subscription_purchase: "订阅购买",
  };
  let offset = 0;
  const PAGE = 50;
  let allEntries = [];

  function reasonLabel(r) { return REASON_LABEL[r] || r; }
  function amountHtml(n) {
    const s = n > 0 ? `+${n}` : String(n);
    return `<span style="color:${n > 0 ? 'var(--green,#38a169)' : 'var(--red,#e53e3e)'};font-weight:600">${s}</span>`;
  }

  function renderDrawerEntries(entries, append) {
    const body = $("creditsDrawerBody");
    if (!append) { body.innerHTML = ""; allEntries = []; }
    if (!entries.length && !append) { body.innerHTML = '<p style="text-align:center;color:var(--muted)">暂无记录</p>'; return; }
    allEntries = allEntries.concat(entries);
    entries.forEach((e) => {
      const row = document.createElement("div");
      row.className = "credits-entry";
      const thumb = e.resultUrl ? `<img class="credits-thumb" src="${e.resultUrl}" loading="lazy" alt="">` : `<div class="credits-thumb-placeholder"></div>`;
      row.innerHTML = `
        <div class="credits-entry-left">${thumb}</div>
        <div class="credits-entry-mid">
          <div class="credits-entry-reason">${reasonLabel(e.reason)}</div>
          ${e.prompt ? `<div class="credits-entry-prompt">${e.prompt.slice(0, 60)}${e.prompt.length > 60 ? "…" : ""}</div>` : ""}
          <div class="credits-entry-time">${new Date(e.createdAt).toLocaleString("zh-CN")}</div>
        </div>
        <div class="credits-entry-right">${amountHtml(e.amount)}</div>`;
      body.appendChild(row);
    });
    $("creditsLoadMore").classList.toggle("hidden", entries.length < PAGE);
  }

  async function loadHistory(append) {
    if (!append) { offset = 0; $("creditsDrawerBody").innerHTML = '<div class="credits-loading">加载中…</div>'; }
    try {
      const { entries } = await api(`/api/credits/history?limit=${PAGE}&offset=${offset}`);
      offset += entries.length;
      renderDrawerEntries(entries, append);
    } catch { $("creditsDrawerBody").innerHTML = '<p style="text-align:center;color:var(--red,#e53e3e)">加载失败</p>'; }
  }

  function open() { $("creditsDrawer").classList.remove("hidden"); loadHistory(false); }
  function close() { $("creditsDrawer").classList.add("hidden"); }

  $("creditStatusCard").addEventListener("dblclick", open);
  $("creditsDrawerClose").addEventListener("click", close);
  $("creditsDrawerBackdrop").addEventListener("click", close);
  $("creditsLoadMore").addEventListener("click", () => loadHistory(true));

  // ── 积分明细标签页 ──
  let viewOffset = 0;
  const VIEW_PAGE = 50;
  let cachedEntries = null;

  function skeletonRows(n = 8) {
    return Array.from({length: n}, () =>
      `<div class="credits-entry skeleton">
        <div class="credits-thumb-placeholder skel-box"></div>
        <div class="credits-entry-mid"><div class="skel-line w60"></div><div class="skel-line w40"></div></div>
        <div class="credits-entry-right"><div class="skel-line w30"></div></div>
      </div>`).join("");
  }

  function renderViewEntries(body, entries, append) {
    if (!append) body.innerHTML = "";
    if (!entries.length && !append) { body.innerHTML = '<p style="text-align:center;color:var(--muted);padding:20px">暂无记录</p>'; return; }
    entries.forEach((e) => {
      const row = document.createElement("div");
      row.className = "credits-entry";
      const thumb = e.resultUrl ? `<img class="credits-thumb" src="${e.resultUrl}" loading="lazy" alt="">` : `<div class="credits-thumb-placeholder"></div>`;
      row.innerHTML = `
        <div class="credits-entry-left">${thumb}</div>
        <div class="credits-entry-mid">
          <div class="credits-entry-reason">${reasonLabel(e.reason)}</div>
          ${e.prompt ? `<div class="credits-entry-prompt">${e.prompt.slice(0, 60)}${e.prompt.length > 60 ? '…' : ''}</div>` : ''}
          <div class="credits-entry-time">${new Date(e.createdAt).toLocaleString('zh-CN')}</div>
        </div>
        <div class="credits-entry-right">${amountHtml(e.amount)}</div>`;
      body.appendChild(row);
    });
  }

  async function creditsViewLoad(append) {
    const body = $("creditsViewBody");
    if (!append) {
      viewOffset = 0;
      if (cachedEntries) {
        renderViewEntries(body, cachedEntries, false);
        $("creditsViewLoadMore").classList.toggle("hidden", cachedEntries.length < VIEW_PAGE);
      } else {
        body.innerHTML = skeletonRows();
      }
    }
    try {
      const { entries } = await api(`/api/credits/history?limit=${VIEW_PAGE}&offset=${viewOffset}`);
      viewOffset += entries.length;
      if (!append) cachedEntries = entries;
      renderViewEntries(body, entries, append);
      $("creditsViewLoadMore").classList.toggle("hidden", entries.length < VIEW_PAGE);
    } catch { if (!append) body.innerHTML = '<p style="text-align:center;color:var(--red,#e53e3e);padding:20px">加载失败</p>'; }
  }

  window.creditsViewLoad = creditsViewLoad;
  $("creditsViewLoadMore").addEventListener("click", () => creditsViewLoad(true));
})();

// ── Panel resizer ──
(function () {
  const resizer = $("panelResizer");
  const bottomPanels = resizer?.nextElementSibling;
  if (!resizer || !bottomPanels) return;
  let startY, startH;
  resizer.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = bottomPanels.offsetHeight;
    resizer.classList.add("dragging");
    const onMove = (e) => {
      const delta = startY - e.clientY;
      const composer = resizer.closest(".primary-composer");
      const max = composer ? composer.offsetHeight - 60 : window.innerHeight * 0.8;
      bottomPanels.style.height = Math.min(max, Math.max(80, startH + delta)) + "px";
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
})();
