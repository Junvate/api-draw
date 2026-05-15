# 多图并行生成：实现计划

## 目标

- 用户在数量选择器选 1~4，真正生成对应数量的图。
- 并行策略：**一次请求 `n=N`**，让上游自己并发。
- 语义：部分成功允许（上游返回 data[] 条数可能 < N，缺失的条目作为失败）；整个请求失败则全部失败。
- 积分：预扣 N × 单价；任务失败全退；部分成功按"返回多少张扣多少张"，多扣的部分退回。
- UI：画布主图 + 下方缩略图横排，点击缩略图切换主图。

---

## 现状（file:line）

- 前端数量选择器 & state：`public/workspace.html:84-90`、`public/script.js:18`、`:894-901`，payload 包含 `count`（`:240`）
- 后端 DTO 缺 `count`：`backend/src/modules/image/dto.ts`（只有 `refs` 等字段，没有 count/n）
- 后端 `createTask` 硬编码 `imageCount: 1`：`image.service.ts:104`
- 单价计算没乘数量：`image.service.ts:83`
- `callGatewayGeneration` / `callGatewayEdit` **只保留 `data[0]`**：`:357-376` / `:405-440`（返回单个 `{url, format,...}`）
- `processTask` 在成功分支只 `create` 一条 `ImageResult`：`:169-209`
- `publicTask` 已经输出 `images: (task.results||[]).map(...)`：`:298` ✓（无需改，新建多条 results 就会正确序列化）
- Prisma schema `ImageTask -> ImageResult` 已经是 1:N，`imageCount` 字段已存在（`prisma/schema.prisma:192-246`）→ **无需迁移**
- 前端 result 渲染已有 `multi-result-grid` 雏形（`script.js:453,472-483`；`app.css:1832-1842`），但样式粗糙、没有"主图+缩略图"交互、没有单独错误态

---

## 实现变更

### 1. 后端 DTO：接受 count

**`backend/src/modules/image/dto.ts`**

新增字段：
```ts
@IsOptional()
@Transform(({ value }) => value === undefined || value === "" ? undefined : Number(value))
@IsInt()
@Min(1)
@Max(4)
count?: number;
```

### 2. 后端 createTask：扣 N 倍积分、写入 imageCount

**`image.service.ts:75-122`** 改两处：

- 计算 `count = Math.max(1, Math.min(4, Number(dto.count) || 1))`，遵循该模型 `ModelConfig.maxImagesPerRequest`（若 <count 则夹取并记一条 warning log，不 throw，以兼容旧配置）
- `unitCost = (size==="3840x2160"?8:size==="2048x2048"?6:(gateway.costCredits||1))`；`totalCost = unitCost * count`
- 预扣改成 `amount: -totalCost`，reason 仍 `generation_hold`
- `imageTask.create({ ... imageCount: count, costCredits: totalCost })`

### 3. 后端 callGatewayGeneration/Edit：返回数组

两个方法现在返回单个 `{url,format,width,height,storageKey}`。改为：

```ts
private async callGatewayGeneration(task, gateway, apiKey): Promise<GeneratedImage[]>
```

- HTTP body 里 `n: task.imageCount`（已存在）保持
- 遍历 `payload.data ?? []`，对每条 `{b64_json?, url?}`：若 `url` 直接保留；若 `b64_json` 调 `persistGeneratedImage` 落地
- 若 `data` 为空数组且无 `error`：抛 `"图像网关没有返回结果"`（保留原错误语义）
- 注意：`persistGeneratedImage` 当前可能把结果放到同一个 `taskId` 目录下，需要为每张图生成独立文件名（加 index 或 nanoid），避免覆盖。检查后再决定。

### 4. 后端 processTask 成功分支：批量落库 + 多扣积分退回

**`image.service.ts:166-210`**：

```ts
const results = await this.callGateway(task, task.gateway); // 现在是数组
const returnedCount = results.length;
const shortfall = task.imageCount - returnedCount; // >=0

await this.prisma.$transaction(async (tx) => {
  // 批量创建所有结果
  await tx.imageResult.createMany({
    data: results.map((r) => ({
      taskId: task.id,
      url: r.url,
      format: r.format,
      width: r.width, height: r.height,
      storageKey: r.storageKey,
    })),
  });

  // 部分成功：退回多扣的积分
  if (shortfall > 0) {
    const unitCost = task.costCredits / task.imageCount; // 单价
    const refundAmount = Math.round(unitCost * shortfall);
    await tx.walletEntry.create({
      data: {
        userId: task.userId,
        amount: refundAmount,
        reason: "generation_partial_refund",
        refId: task.id,
        actorId: task.userId,
      },
    });
    // 更新 costCredits 为实际扣除值
    await tx.imageTask.update({
      where: { id: task.id },
      data: { costCredits: task.costCredits - refundAmount },
    });
  }

  // UsageRecord 用实际返回张数
  await tx.usageRecord.create({
    data: { ..., imageCount: returnedCount, costCredits: task.costCredits - (shortfall>0?refundAmount:0) },
  });

  // status: returnedCount === 0 不会走到这里（callGateway 抛错）
  //        returnedCount < task.imageCount → status 仍为 "success" 但前端通过 images.length < task.imageCount 展示"部分成功"
  return tx.imageTask.update({ where: { id: task.id }, data: { status: "success", ... } });
});
```

### 5. publicTask：暴露 imageCount 和单价

**`image.service.ts:~280-307`** 在返回体里加：

```ts
image_count: task.imageCount,
imageCount: task.imageCount,
returned_count: (task.results || []).length,
returnedCount: (task.results || []).length,
// images 保持原样，前端根据长度渲染
```

这样前端能区分"请求 4 张 / 实际回来 3 张"并提示。

### 6. 前端：result 区域改为"主图 + 缩略图条"

**`public/workspace.html`** 在 `canvas-stage` 内主图区下方增加容器：

```html
<div class="stage-thumbs hidden" id="stageThumbs" role="tablist" aria-label="生成结果切换"></div>
```

（放在 `stage-result-image` 的父节点 `canvas-stage` 底部，作为 overlay 条）

**`public/script.js` renderResultCard (`:448-511`)** 重构：

- 计算 `allImages = (job.images || []).map(i => i.url).filter(Boolean)`
- 若 `allImages.length <= 1`：保留现状单图逻辑
- 若 `allImages.length > 1`：
  - 主图：`canvasStage` 背景/img 切到 `state.activeImageIndex`（默认 0）对应的 url
  - 缩略图条：渲染 `task.imageCount` 个 slot：
    - 已返回的图片 → `<button class="thumb"><img src={url}></button>`，点击切换主图
    - 未返回的（shortfall）→ `<div class="thumb thumb-error" title="该张生成失败">`
  - 当前 active slot 加 `.active` 样式
- 移除现有的 `resultArt` grid（改为缩略图条，不再全幅展开）

**单图按钮（下载/打开/继续编辑）** 始终指向当前选中的主图（`state.activeImageIndex`）。点击缩略图时同步更新这些按钮的 href 和 `state.activeResultJob.activeUrl`。

### 7. 前端：CSS

**`public/app.css`** 新增：

```css
.stage-thumbs {
  position: absolute;
  left: 50%; bottom: 12px; transform: translateX(-50%);
  display: flex; gap: 8px;
  padding: 6px; border-radius: 12px;
  background: rgba(17,24,39,.78); backdrop-filter: blur(6px);
  max-width: calc(100% - 24px); overflow-x: auto;
  z-index: 4;
}
.stage-thumbs .thumb {
  width: 56px; height: 56px; padding: 0;
  border: 2px solid transparent; border-radius: 8px; overflow: hidden;
  background: rgba(255,255,255,.06); cursor: pointer; flex: 0 0 auto;
}
.stage-thumbs .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.stage-thumbs .thumb.active { border-color: #fff; }
.stage-thumbs .thumb:hover { opacity: .9; }
.stage-thumbs .thumb-error {
  display: grid; place-items: center;
  color: rgba(255,255,255,.72); font-size: 18px;
}
.stage-thumbs .thumb-error::before { content: "⚠"; }

/* 移动端 */
@media (max-width: 820px) {
  .stage-thumbs .thumb { width: 48px; height: 48px; }
}
```

删除或保留现有 `.multi-result-grid`（它不再使用但保留不影响），顺手删掉。

### 8. 前端：生成中的 loading 状态

生成中（job.status == "pending"/"processing"）时，`stage-thumbs` 隐藏，只显示一个 skeleton（已有 placeholder 逻辑）。返回后立刻渲染缩略图条。不做"每张独立 loading"—— 因为单次上游调用，上游不会流式返回每张图。

### 9. 前端：提示部分成功

在 `formatResultMessage(job)` 里：
- 若 `job.imageCount > (job.images?.length || 0) > 0` → 附加 "（已生成 X/Y 张，X 张网关未返回）" 文案。

---

## 不做的事

- 不改并行策略为 N 次独立请求（用户选了"一次 n=N"）
- 不改 DB schema（已是 1:N，`imageCount` 已存在）
- 不改 `ModelConfig.maxImagesPerRequest` 默认值（种子是 1，需要用户后续在管理后台调整到 4 才能真正放开，否则 count 会被夹回 1 —— 会在实现时 console.warn 并附加到响应体，让前端提示"已自动降级为 1 张"）

**需要用户决定**：`maxImagesPerRequest` 默认要不要改成 4？现在种子是 1，直接选 4 会被夹。我倾向**保持 1 → 让管理员显式放开**。但为了开箱即用，可在 seedDefaults 改为 4。

---

## 验证

1. 后端：`count=3` 提交 → 上游返回 3 张 → `images` 数组 3 条，`costCredits = 3×单价`，钱包只扣一次 `3×单价`
2. 后端：`count=4` 但上游返回 2 张 → `images` 2 条，产生 `generation_partial_refund` 记录金额 = 2×单价，`costCredits` 更新为 2×单价
3. 后端：`count=3` 且上游失败 → 走 `failTask` 全退（原逻辑，`task.costCredits` 是总价，一次性退回）
4. 前端：`job.imageCount=4, images.length=3` → 缩略图条显示 4 个格子（3 图 + 1 error）
5. 前端：点击缩略图切换主图、下载/编辑按钮指向对应 url
6. 前端：移动端 (≤820px) 缩略图条正确显示不遮挡主图

---

## 风险

- **`persistGeneratedImage` 的文件命名冲突**：当前可能用 taskId 命名，多张会互相覆盖。实现前需读该函数并修正（加 index 后缀）。
- **前端 `state.activeResultJob` 结构依赖**：需要补 `activeImageIndex` 字段，continueEditingActiveResult 用的 `resultUrl` 要切到当前 index。
- **ModelConfig.maxImagesPerRequest=1** 会让所有新用户选 2~4 都被夹回 1，默认体验差。建议 seedDefaults 改成 4。

