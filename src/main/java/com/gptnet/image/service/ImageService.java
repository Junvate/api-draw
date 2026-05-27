package com.gptnet.image.service;

import com.gptnet.image.dto.CreateImageRequest;
import com.gptnet.image.model.Gateway;
import com.gptnet.image.model.ImageResult;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.service.UpstreamClient.Part;
import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Service
public class ImageService {
  private static final Logger log = LoggerFactory.getLogger(ImageService.class);
  private static final int MAX_REFERENCE_IMAGES = 16;
  private static final int MAX_IMAGES_PER_REQUEST = 20;
  private static final long MAX_REFERENCE_IMAGE_BYTES = 50L * 1024L * 1024L;
  private final Db db;
  private final SecurityService security;
  private final AuthService auth;
  private final UpstreamClient upstream;
  private final QueueService queue;
  private final StorageService storage;
  private final SensitiveWordService sensitiveWords;
  private final TransactionTemplate transactions;
  private final String storageRoot;
  private final int failureThreshold;
  private final long cooldownMs;

  public ImageService(
    Db db,
    SecurityService security,
    AuthService auth,
    UpstreamClient upstream,
    QueueService queue,
    StorageService storage,
    SensitiveWordService sensitiveWords,
    TransactionTemplate transactions,
    @Value("${LOCAL_STORAGE_DIR:storage}") String storageRoot,
    @Value("${GATEWAY_FAILURE_THRESHOLD:30}") int failureThreshold,
    @Value("${GATEWAY_COOLDOWN_MS:300000}") long cooldownMs
  ) {
    this.db = db;
    this.security = security;
    this.auth = auth;
    this.upstream = upstream;
    this.queue = queue;
    this.storage = storage;
    this.sensitiveWords = sensitiveWords;
    this.transactions = transactions;
    this.storageRoot = storageRoot;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  @Transactional
  public void seedDefaults() {
    Integer plans = db.jdbc().queryForObject("SELECT count(*) FROM \"Plan\"", Map.of(), Integer.class);
    if (plans == null || plans == 0) {
      db.jdbc().update("""
        INSERT INTO "Plan" ("id", "name", "credits", "priceCents", "interval", "active")
        VALUES
          ('starter', '入门版', 300, 2900, 'month', true),
          ('pro', '专业版', 1200, 9900, 'month', true),
          ('team', '团队版', 5000, 39900, 'month', true)
        ON CONFLICT ("id") DO NOTHING
        """, Map.of());
    }
    Integer gateways = db.jdbc().queryForObject("SELECT count(*) FROM \"Gateway\"", Map.of(), Integer.class);
    if (gateways == null || gateways == 0) {
      db.jdbc().update("""
        INSERT INTO "Gateway" (
          "id", "name", "provider", "baseUrl", "apiKeyEnv", "healthCheckPath", "generationPath",
          "model", "costCredits", "timeoutMs", "enabled", "priority"
        )
        VALUES (
          'openai-primary', 'OpenAI 主网关', 'openai'::"GatewayProvider", 'https://api.openai.com/v1',
          NULL, '/models', '/images/generations', 'gpt-image-2', 8, 300000, true, 10
        )
        ON CONFLICT ("id") DO NOTHING
        """, Map.of());
    }
    db.jdbc().update("""
      INSERT INTO "ModelConfig" (
        "id", "model", "enabled", "defaultSize", "defaultQuality",
        "allowTransparent", "allowHighQuality", "maxImagesPerRequest"
      )
      VALUES (:id, 'gpt-image-2', true, '1024x1024', 'auto', true, true, 1)
      ON CONFLICT ("model") DO NOTHING
      """, Map.of("id", db.id()));
  }

  public ImageTask createTask(CreateTaskParams params) {
    String prompt = cleanFormString(params.dto().getPrompt()).trim();
    if (prompt.length() < 4) throw AppException.badRequest("PROMPT_TOO_SHORT", "提示词至少输入 4 个字");
    if (prompt.length() > 8000) throw AppException.badRequest("PROMPT_TOO_LONG", "提示词不能超过 8000 个字");
    sensitiveWords.assertAllowed(params.userId(), params.apiKeyId(), params.requestId(), prompt);
    String requestedModel = Optional.of(cleanFormString(params.dto().getModel())).filter(s -> !s.isBlank()).orElse("gpt-image-2");
    String requestedQuality = cleanFormString(params.dto().getQuality());
    String normalizedSize = normalizeSize(firstNonBlank(params.dto().getSize(), params.dto().getRatio()), requestedQuality);
    Gateway gateway = selectGateway(requestedModel, normalizedSize);
    int unitCost = is4kSize(normalizedSize) ? 8 : is2kSize(normalizedSize) ? 6 : Math.max(1, gateway.costCredits());
    int imageCount = normalizeImageCount(params.dto().getCount());
    int cost = unitCost * imageCount;
    List<MultipartFile> referenceFiles = validateReferenceFiles(params.referenceFiles());
    String taskId = db.id();
    if (!referenceFiles.isEmpty()) persistReferenceImages(taskId, referenceFiles);
    return transactions.execute(status -> createTaskRecord(params, taskId, gateway, prompt, normalizedSize, requestedQuality, imageCount, cost));
  }

  public ImageTask createTaskRecord(CreateTaskParams params, String taskId, Gateway gateway, String prompt, String normalizedSize, String requestedQuality, int imageCount, int cost) {
    try {
      auth.lockUserWallet(params.userId());
      if (db.walletBalance(params.userId()) < cost) throw AppException.badRequest("INSUFFICIENT_CREDITS", "积分不足");
      db.jdbc().update("""
        INSERT INTO "ImageTask" (
          "id", "userId", "apiKeyId", "gatewayId", "requestId", "model", "prompt", "size",
          "quality", "outputFormat", "background", "imageCount", "costCredits", "status"
        )
        VALUES (
          :id, :userId, :apiKeyId, :gatewayId, :requestId, :model, :prompt, :size,
          :quality, :outputFormat, :background, :imageCount, :costCredits, 'queued'::"ImageTaskStatus"
        )
        """, new MapSqlParameterSource()
        .addValue("id", taskId)
        .addValue("userId", params.userId())
        .addValue("apiKeyId", params.apiKeyId())
        .addValue("gatewayId", gateway.id())
        .addValue("requestId", params.requestId())
        .addValue("model", gateway.model())
        .addValue("prompt", prompt)
        .addValue("size", normalizedSize)
        .addValue("quality", normalizeQuality(requestedQuality))
        .addValue("outputFormat", Optional.of(cleanFormString(params.dto().getOutput_format())).filter(s -> !s.isBlank()).orElse("png"))
        .addValue("background", Optional.of(cleanFormString(params.dto().getBackground())).filter(s -> !s.isBlank()).orElse("opaque"))
        .addValue("imageCount", imageCount)
        .addValue("costCredits", cost));
      db.jdbc().update("""
        INSERT INTO "WalletEntry" ("id", "userId", "amount", "reason", "refId", "actorId")
        VALUES (:id, :userId, :amount, 'generation_hold'::"WalletEntryReason", :refId, :actorId)
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("userId", params.userId())
        .addValue("amount", -cost)
        .addValue("refId", taskId)
        .addValue("actorId", params.userId()));
    } catch (DataIntegrityViolationException exception) {
      if (params.apiKeyId() != null && params.requestId() != null) {
        cleanupReferenceImages(taskId);
        return db.imageTaskByApiKeyAndRequest(params.apiKeyId(), params.requestId()).map(db::hydrateTask).orElseThrow();
      }
      cleanupReferenceImages(taskId);
      throw exception;
    } catch (RuntimeException exception) {
      cleanupReferenceImages(taskId);
      throw exception;
    }
    return db.imageTaskById(taskId).orElseThrow();
  }

  public ImageTask queueTask(ImageTask task) {
    if (task == null || !"queued".equals(task.status())) return task;
    try {
      queue.enqueue(task.id());
      return task;
    } catch (Exception exception) {
      String code = exception instanceof QueueService.QueueOverloadedException ? "QUEUE_OVERLOADED" : "QUEUE_UNAVAILABLE";
      String message = exception instanceof QueueService.QueueOverloadedException ? exception.getMessage() : "任务队列当前不可用";
      log.error("[task={}] Queue error code={} message={}", task.id(), code, message, exception);
      failTask(task, code, message, true);
      throw AppException.unavailable(code, message);
    }
  }

  public ImageTask ensureQueued(ImageTask task) {
    if (task == null || !"queued".equals(task.status())) return task;
    try {
      queue.enqueueExisting(task.id());
    } catch (Exception exception) {
      log.warn("[task={}] Unable to refresh queued task membership: {}", task.id(), exception.getMessage());
    }
    return task;
  }

  public ImageTask processTask(String taskId, int attempt, int maxAttempts) {
    ImageTask task = db.imageTaskById(taskId).map(db::hydrateTask).orElse(null);
    if (task == null || !"queued".equals(task.status())) return task;
    Gateway gateway = activeGatewayForTask(task).orElse(null);
    if (gateway == null) return failTask(task, "GATEWAY_UNAVAILABLE", "任务网关当前不可用", true);

    long started = System.currentTimeMillis();
    int claimed = db.jdbc().update("""
      UPDATE "ImageTask" SET "status" = 'processing'::"ImageTaskStatus", "startedAt" = now(), "updatedAt" = now()
      WHERE "id" = :id AND "status" = 'queued'::"ImageTaskStatus"
      """, Map.of("id", task.id()));
    if (claimed == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
    try {
      int existingCount = db.resultsForTask(task.id()).size();
      if (existingCount >= task.imageCount()) {
        int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
        return completeTaskSuccess(task, gateway, new GenerationRun(List.of(), null), latencyMs, existingCount, 0, task.costCredits());
      }
      GenerationRun run = callGateway(task, gateway);
      int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
      int returnedCount = db.resultsForTask(task.id()).size();
      if (returnedCount == 0) throw run.lastError() == null ? new UpstreamException("UPSTREAM_EMPTY_RESULT", "图像网关没有返回结果", 0, true) : run.lastError();
      if (returnedCount < task.imageCount() && attempt < maxAttempts) {
        return requeuePartialTask(task, run, returnedCount, attempt);
      }
      if (returnedCount < task.imageCount()) {
        throw new UpstreamException("UPSTREAM_PARTIAL_RESULT", partialResultMessage(task.imageCount(), returnedCount, run.lastError()), 0, true);
      }
      int shortfall = Math.max(0, task.imageCount() - returnedCount);
      int unitCost = task.imageCount() > 0 ? task.costCredits() / task.imageCount() : task.costCredits();
      int refundAmount = shortfall > 0 ? unitCost * shortfall : 0;
      int finalCost = task.costCredits() - refundAmount;
      return completeTaskSuccess(task, gateway, run, latencyMs, returnedCount, refundAmount, finalCost);
    } catch (Exception exception) {
      StorageService.StorageException storageException = storageException(exception);
      if (storageException != null) {
        String message = storageException.getMessage() == null ? "结果存储失败" : storageException.getMessage();
        log.error("[task={}] Storage error: {}", task.id(), message, exception);
        return failTask(task, "STORAGE_FAILED", message, true);
      }
      UpstreamException upstreamException = upstreamException(exception);
      String message = exception.getMessage() == null ? String.valueOf(exception) : exception.getMessage();
      String code = upstreamException == null ? "UPSTREAM_FAILED" : upstreamException.code();
      boolean retryable = upstreamException == null || upstreamException.retryable();
      String reqUrl = upstreamException != null ? upstreamException.requestUrl() : null;
      String rawResp = upstreamException != null ? upstreamException.rawResponse() : null;
      log.error("[task={}] Gateway error gateway={} code={} attempt={}/{} retryable={} message={}",
        task.id(), gateway.name(), code, attempt, maxAttempts, retryable, message, exception);
      if (countsAgainstGatewayHealth(upstreamException)) {
        recordGatewayFailure(gateway, message, System.currentTimeMillis() - started, code);
      }
      if (reqUrl != null || rawResp != null) {
        db.jdbc().update("""
          UPDATE "ImageTask" SET "requestUrl" = :requestUrl, "rawResponse" = :rawResponse
          WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
          """, new MapSqlParameterSource()
          .addValue("id", task.id())
          .addValue("requestUrl", reqUrl == null ? "" : reqUrl)
          .addValue("rawResponse", truncate(rawResp, 4000)));
      }
      if (retryable && attempt < maxAttempts) {
        int requeued = db.jdbc().update("""
          UPDATE "ImageTask" SET
            "status" = 'queued'::"ImageTaskStatus",
            "retryCount" = :retryCount,
            "errorCode" = :code,
            "errorMessage" = :message,
            "updatedAt" = now()
          WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
          """, new MapSqlParameterSource()
          .addValue("id", task.id())
          .addValue("retryCount", attempt)
          .addValue("code", code)
          .addValue("message", truncate(message, 1000)));
        if (requeued == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
        return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
      }
      return failTask(task, code, message, true);
    }
  }

  public ImageTask failTask(ImageTask task, String code, String message, boolean refund) {
    return transactions.execute(status -> failTaskInTransaction(task, code, message, refund));
  }

  private ImageTask requeuePartialTask(ImageTask task, GenerationRun run, int returnedCount, int attempt) {
    String message = partialResultMessage(task.imageCount(), returnedCount, run.lastError());
    int updated = db.jdbc().update("""
      UPDATE "ImageTask" SET
        "status" = 'queued'::"ImageTaskStatus",
        "retryCount" = :retryCount,
        "errorCode" = :code,
        "errorMessage" = :message,
        "updatedAt" = now()
      WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
      """, new MapSqlParameterSource()
      .addValue("id", task.id())
      .addValue("retryCount", attempt)
      .addValue("code", "PARTIAL_RESULT_RETRYING")
      .addValue("message", truncate(message, 1000)));
    if (updated == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
    return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
  }

  private ImageTask completeTaskSuccess(ImageTask task, Gateway gateway, GenerationRun run, int latencyMs, int returnedCount, int refundAmount, int finalCost) {
    return transactions.execute(status -> {
      int updated = db.jdbc().update("""
        UPDATE "ImageTask" SET
          "status" = 'success'::"ImageTaskStatus",
          "latencyMs" = :latencyMs,
          "costCredits" = :costCredits,
          "errorCode" = :code,
          "errorMessage" = :message,
          "finishedAt" = now(),
          "updatedAt" = now()
        WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
        """, new MapSqlParameterSource()
        .addValue("id", task.id())
        .addValue("latencyMs", latencyMs)
        .addValue("costCredits", finalCost)
        .addValue("code", run.lastError() == null ? null : run.lastError().code())
        .addValue("message", run.lastError() == null ? null : truncate(run.lastError().getMessage(), 1000)));
      if (updated == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
      if (refundAmount > 0) refundTaskCredits(task, refundAmount);
      db.jdbc().update("""
        INSERT INTO "UsageRecord" (
          "id", "userId", "apiKeyId", "taskId", "model", "imageCount", "costCredits", "latencyMs", "status"
        )
        VALUES (:id, :userId, :apiKeyId, :taskId, :model, :imageCount, :costCredits, :latencyMs, 'success')
        ON CONFLICT ("taskId") DO UPDATE SET
          "status" = 'success',
          "imageCount" = EXCLUDED."imageCount",
          "costCredits" = EXCLUDED."costCredits",
          "latencyMs" = EXCLUDED."latencyMs"
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("userId", task.userId())
        .addValue("apiKeyId", task.apiKeyId())
        .addValue("taskId", task.id())
        .addValue("model", task.model())
        .addValue("imageCount", returnedCount)
        .addValue("costCredits", finalCost)
        .addValue("latencyMs", latencyMs));
      db.jdbc().update("""
        UPDATE "Gateway" SET
          "healthStatus" = 'healthy'::"GatewayHealth",
          "consecutiveFailures" = 0,
          "disabledUntil" = NULL,
          "lastCheckedAt" = now(),
          "lastSuccessAt" = now(),
          "lastLatencyMs" = :latencyMs,
          "lastError" = NULL,
          "updatedAt" = now()
        WHERE "id" = :id
        """, Map.of("id", gateway.id(), "latencyMs", latencyMs));
      return db.imageTaskById(task.id()).map(db::hydrateTask).orElseThrow();
    });
  }

  private ImageTask failTaskInTransaction(ImageTask task, String code, String message, boolean refund) {
    int updated = db.jdbc().update("""
      UPDATE "ImageTask" SET
        "status" = 'failed'::"ImageTaskStatus",
        "errorCode" = :code,
        "errorMessage" = :message,
        "finishedAt" = now(),
        "updatedAt" = now()
      WHERE "id" = :id
        AND "status" NOT IN ('success'::"ImageTaskStatus", 'failed'::"ImageTaskStatus", 'blocked'::"ImageTaskStatus", 'cancelled'::"ImageTaskStatus")
      """, new MapSqlParameterSource()
      .addValue("id", task.id())
      .addValue("code", code)
      .addValue("message", truncate(message, 1000)));
    if (updated == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
    deleteTaskResults(task.id());
    if (refund) refundTaskCredits(task, heldCredits(task));
    db.jdbc().update("""
      INSERT INTO "UsageRecord" (
        "id", "userId", "apiKeyId", "taskId", "model", "imageCount", "costCredits", "status"
      )
      VALUES (:id, :userId, :apiKeyId, :taskId, :model, :imageCount, 0, 'failed')
      ON CONFLICT ("taskId") DO UPDATE SET "status" = 'failed', "costCredits" = 0
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("userId", task.userId())
      .addValue("apiKeyId", task.apiKeyId())
      .addValue("taskId", task.id())
      .addValue("model", task.model())
      .addValue("imageCount", task.imageCount()));
    return db.imageTaskById(task.id()).map(db::hydrateTask).orElseThrow();
  }

  private int heldCredits(ImageTask task) {
    Integer value = db.jdbc().queryForObject("""
      SELECT COALESCE(SUM(-"amount"), 0)
      FROM "WalletEntry"
      WHERE "refId" = :refId
        AND "reason" = 'generation_hold'::"WalletEntryReason"
      """, Map.of("refId", task.id()), Integer.class);
    int held = value == null ? 0 : value;
    return held > 0 ? held : Math.max(0, task.costCredits());
  }

  private void deleteTaskResults(String taskId) {
    db.jdbc().update("DELETE FROM \"ImageResult\" WHERE \"taskId\" = :taskId", Map.of("taskId", taskId));
  }

  private void refundTaskCredits(ImageTask task, int amount) {
    if (amount <= 0) return;
    auth.lockUserWallet(task.userId());
    db.jdbc().update("""
      INSERT INTO "WalletEntry" ("id", "userId", "amount", "reason", "refId", "actorId")
      VALUES (:id, :userId, :amount, 'generation_refund'::"WalletEntryReason", :refId, :actorId)
      ON CONFLICT ("refId") WHERE "reason" = 'generation_refund'::"WalletEntryReason"
      DO UPDATE SET "amount" = GREATEST("WalletEntry"."amount", EXCLUDED."amount")
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("userId", task.userId())
      .addValue("amount", amount)
      .addValue("refId", task.id())
      .addValue("actorId", task.userId()));
  }

  public Map<String, Object> publicTask(ImageTask rawTask, String userId) {
    return publicTask(rawTask, userId, true);
  }

  public Map<String, Object> publicTask(ImageTask rawTask, String userId, boolean includeDetails) {
    ImageTask task = includeDetails && rawTask.results().isEmpty() ? db.hydrateTask(rawTask) : rawTask;
    ImageResult first = task.results().isEmpty() ? null : task.results().get(0);
    String display = first == null ? null : "/api/images/" + task.id() + "/result";
    String download = first == null ? null : "/api/images/" + task.id() + "/download";
    List<Map<String, Object>> images = new ArrayList<>();
    for (int i = 0; i < task.results().size(); i++) {
      ImageResult r = task.results().get(i);
      String suffix = i == 0 ? "" : "?i=" + i;
      images.add(Maps.of(
        "url", r.url(),
        "display_url", "/api/images/" + task.id() + "/result" + suffix,
        "displayUrl", "/api/images/" + task.id() + "/result" + suffix,
        "download_url", "/api/images/" + task.id() + "/download" + suffix,
        "downloadUrl", "/api/images/" + task.id() + "/download" + suffix
      ));
    }
    return Maps.of(
      "object", "image_generation",
      "id", task.id(),
      "task_id", task.id(),
      "status", publicStatus(task.status()),
      "model", task.model(),
      "ratio", task.size(),
      "size", task.size(),
      "quality", task.quality(),
      "prompt", task.prompt(),
      "result_url", first == null ? null : first.url(),
      "resultUrl", first == null ? null : first.url(),
      "display_url", display,
      "displayUrl", display,
      "download_url", download,
      "downloadUrl", download,
      "images", images,
      "image_count", task.imageCount(),
      "imageCount", task.imageCount(),
      "returned_count", task.results().size(),
      "returnedCount", task.results().size(),
      "error", task.errorMessage(),
      "cost_credits", task.costCredits(),
      "costCredits", task.costCredits(),
      "credits_remaining", includeDetails ? db.walletBalance(userId) : null,
      "created_at", task.createdAt(),
      "createdAt", task.createdAt(),
      "completed_at", task.finishedAt(),
      "completedAt", task.finishedAt()
    );
  }

  public Gateway selectGateway(String model, String size) {
    String preferredGroup = groupForSize(size);
    List<Gateway> all = db.enabledGatewaysForModel(model).stream()
      .filter(item -> resolveGatewayApiKey(item, false) != null)
      .filter(item -> !isCooling(item))
      .toList();
    // Try preferred group first, then fall back to any available group
    return all.stream().filter(item -> groupMatches(item.upstreamGroup(), preferredGroup)).findFirst()
      .or(() -> all.stream().findFirst())
      .orElseThrow(() -> AppException.unavailable("NO_AVAILABLE_GATEWAY", "没有可用渠道，请稍后重试"));
  }

  private Optional<Gateway> activeGatewayForTask(ImageTask task) {
    Gateway current = task.gateway();
    if (current != null && current.enabled() && !isCooling(current) && resolveGatewayApiKey(current, false) != null) {
      return Optional.of(current);
    }
    try {
      Gateway replacement = selectGateway(task.model(), task.size());
      db.jdbc().update("""
        UPDATE "ImageTask" SET "gatewayId" = :gatewayId, "updatedAt" = now()
        WHERE "id" = :id AND "status" = 'queued'::"ImageTaskStatus"
        """, Map.of("id", task.id(), "gatewayId", replacement.id()));
      return Optional.of(replacement);
    } catch (RuntimeException exception) {
      return Optional.empty();
    }
  }

  public String resolveGatewayApiKey(Gateway gateway) {
    return resolveGatewayApiKey(gateway, true);
  }

  public String resolveGatewayApiKey(Gateway gateway, boolean throwOnInvalid) {
    if (gateway.apiKeyCiphertext() != null && !gateway.apiKeyCiphertext().isBlank()) {
      String decrypted = security.decryptSecret(gateway.apiKeyCiphertext());
      if (decrypted != null && !decrypted.isBlank()) return decrypted;
      if (throwOnInvalid) throw new RuntimeException("渠道 API Key 无法解密，请重新保存该渠道密钥");
      return null;
    }
    if (throwOnInvalid) throw new RuntimeException("渠道 API Key 未配置");
    return null;
  }

  public String upstreamUrl(String baseUrl, String path) {
    String normalized = path == null ? "" : path.trim();
    if (normalized.isBlank()) return baseUrl.replaceAll("/$", "");
    if (normalized.matches("(?i)^https?://.*")) return normalized;
    return baseUrl.replaceAll("/$", "") + "/" + normalized.replaceAll("^/", "");
  }

  private GenerationRun callGateway(ImageTask task, Gateway gateway) throws Exception {
    String apiKey = resolveGatewayApiKey(gateway);
    List<LoadedReferenceImage> referenceImages = loadReferenceImages(task.id());
    int existingCount = db.resultsForTask(task.id()).size();
    int count = Math.max(0, task.imageCount() - existingCount);
    if (count == 0) return new GenerationRun(List.of(), null);
    ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
    try {
      List<CompletableFuture<ImageAttempt>> futures = new ArrayList<>();
      for (int index = 0; index < count; index += 1) {
        int attemptIndex = index;
        int variantIndex = existingCount + index;
        futures.add(CompletableFuture.supplyAsync(() -> callGatewayImage(task, gateway, apiKey, referenceImages, count, attemptIndex, variantIndex), pool));
      }
      List<GatewayResult> results = new ArrayList<>();
      UpstreamException lastError = null;
      for (CompletableFuture<ImageAttempt> future : futures) {
        ImageAttempt attempt = future.join();
        if (attempt.result() != null) results.add(attempt.result());
        if (attempt.error() != null) lastError = attempt.error();
      }
      return new GenerationRun(results, lastError);
    } finally {
      pool.shutdown();
    }
  }

  private ImageAttempt callGatewayImage(ImageTask task, Gateway gateway, String apiKey, List<LoadedReferenceImage> referenceImages, int count, int attemptIndex, int variantIndex) {
    try {
      GatewayResult result = referenceImages.isEmpty()
        ? callGatewayGeneration(task, gateway, apiKey, 1, variantIndex)
        : callGatewayEdit(task, gateway, apiKey, referenceImages, 1, variantIndex);
      persistGatewayResult(task, result);
      db.jdbc().update("""
        UPDATE "ImageTask" SET "updatedAt" = now()
        WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
        """, Map.of("id", task.id()));
      return new ImageAttempt(variantIndex, result, null);
    } catch (Exception exception) {
      if (storageException(exception) != null) throw new RuntimeException(exception);
      UpstreamException error = upstreamException(exception);
      if (error == null) error = new UpstreamException("UPSTREAM_FAILED", exception.getMessage(), 0, true);
      log.warn("[task={}] Gateway image {}/{} failed gateway={} code={} message={}",
        task.id(), attemptIndex + 1, count, gateway.name(), error.code(), error.getMessage());
      return new ImageAttempt(variantIndex, null, error);
    }
  }

  private void persistGatewayResult(ImageTask task, GatewayResult result) {
    db.jdbc().update("""
      INSERT INTO "ImageResult" ("id", "taskId", "url", "format", "width", "height", "storageKey", "sizeBytes", "hash")
      SELECT :id, :taskId, :url, :format, :width, :height, :storageKey, :sizeBytes, :hash
      WHERE EXISTS (
        SELECT 1 FROM "ImageTask"
        WHERE "id" = :taskId AND "status" = 'processing'::"ImageTaskStatus"
      )
      ON CONFLICT ("taskId", "url") DO UPDATE SET
        "format" = EXCLUDED."format",
        "width" = EXCLUDED."width",
        "height" = EXCLUDED."height",
        "storageKey" = EXCLUDED."storageKey",
        "sizeBytes" = EXCLUDED."sizeBytes",
        "hash" = EXCLUDED."hash"
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("taskId", task.id())
      .addValue("url", result.url())
      .addValue("format", result.format())
      .addValue("width", result.width())
      .addValue("height", result.height())
      .addValue("storageKey", result.storageKey())
      .addValue("sizeBytes", result.sizeBytes())
      .addValue("hash", result.hash()));
    for (ExtraImage extra : result.extras()) {
      db.jdbc().update("""
        INSERT INTO "ImageResult" ("id", "taskId", "url", "format", "storageKey", "sizeBytes", "hash")
        SELECT :id, :taskId, :url, :format, :storageKey, :sizeBytes, :hash
        WHERE EXISTS (
          SELECT 1 FROM "ImageTask"
          WHERE "id" = :taskId AND "status" = 'processing'::"ImageTaskStatus"
        )
        ON CONFLICT ("taskId", "url") DO UPDATE SET
          "storageKey" = EXCLUDED."storageKey",
          "sizeBytes" = EXCLUDED."sizeBytes",
          "hash" = EXCLUDED."hash"
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("taskId", task.id())
        .addValue("url", extra.url())
        .addValue("format", result.format())
        .addValue("storageKey", extra.storageKey())
        .addValue("sizeBytes", extra.sizeBytes())
        .addValue("hash", extra.hash()));
    }
  }

  @SuppressWarnings("unchecked")
  private GatewayResult callGatewayGeneration(ImageTask task, Gateway gateway, String apiKey, int n, int variantIndex) {
    String generationPath = Optional.ofNullable(gateway.generationPath()).filter(s -> !s.isBlank()).orElse("/images/generations");
    String upstreamGroup = Optional.ofNullable(gateway.upstreamGroup()).filter(s -> !s.isBlank()).orElse(groupForSize(task.size()));
    String url = upstreamUrl(gateway.baseUrl(), generationPath);
    Map<String, Object> body = imageGenerationRequestBody(url, task, n);
    if (upstreamGroup != null) body.put("group", upstreamGroup);
    UpstreamClient.UpstreamResponse response = upstream.json(url, "POST",
      Map.of("Authorization", "Bearer " + apiKey), body, gateway.timeoutMs());
    if (!response.ok() && body.containsKey("response_format") && isUnsupportedResponseFormat(response)) {
      body.remove("response_format");
      response = upstream.json(url, "POST", Map.of("Authorization", "Bearer " + apiKey), body, gateway.timeoutMs());
    }
    if (!response.ok()) throw UpstreamException.fromHttp(response.status(), upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status())).withDebug(url, response.text());
    List<Map<String, Object>> dataList = allData(response.payload());
    if (dataList.isEmpty() || (dataList.get(0).get("b64_json") == null && dataList.get(0).get("url") == null)) {
      throw new UpstreamException("UPSTREAM_EMPTY_RESULT", "图像网关没有返回结果", response.status(), true).withDebug(url, response.text());
    }
    if (dataList.get(0).get("url") != null) {
      List<ExtraImage> extras = dataList.stream().skip(1)
        .map(d -> String.valueOf(d.get("url")))
        .filter(u -> !"null".equals(u) && u != null && !u.isBlank())
        .map(u -> new ExtraImage(u, null, null, null))
        .toList();
      return new GatewayResult(String.valueOf(dataList.get(0).get("url")), task.outputFormat(), null, null, null, null, null, extras);
    }
    List<StoredImage> stored = new ArrayList<>();
    for (int i = 0; i < dataList.size(); i++) {
      Map<String, Object> item = dataList.get(i);
      if (item.get("b64_json") != null) stored.add(persistGeneratedImage(task, String.valueOf(item.get("b64_json")), task.outputFormat(), variantIndex + i));
    }
    StoredImage first = stored.get(0);
    List<ExtraImage> extras = stored.stream().skip(1).map(s -> new ExtraImage(s.url(), s.storageKey(), s.sizeBytes(), s.hash())).toList();
    return new GatewayResult(first.url(), task.outputFormat(), null, null, first.storageKey(), first.sizeBytes(), first.hash(), extras);
  }

  private Map<String, Object> imageGenerationRequestBody(String url, ImageTask task, int n) {
    String format = "jpg".equals(task.outputFormat()) ? "jpeg" : task.outputFormat();
    boolean requestUrlResponse = shouldRequestUrlResponse(url, task.model());
    if (isSuperApiImageGenerationUrl(url)) {
      Map<String, Object> body = Maps.of(
        "model", task.model(),
        "prompt", task.prompt(),
        "size", task.size(),
        "quality", task.quality(),
        "format", format
      );
      if (requestUrlResponse) body.put("response_format", "url");
      return body;
    }
    Map<String, Object> body = Maps.of(
      "model", task.model(),
      "prompt", task.prompt(),
      "size", task.size(),
      "quality", task.quality(),
      "output_format", format,
      "background", task.background(),
      "n", n
    );
    if (requestUrlResponse) body.put("response_format", "url");
    return body;
  }

  private boolean isSuperApiImageGenerationUrl(String url) {
    String normalized = Optional.ofNullable(url).orElse("").toLowerCase();
    return normalized.contains("api.superapi.me") && normalized.contains("/images/generations");
  }

  private boolean shouldRequestUrlResponse(String url, String model) {
    String normalizedModel = Optional.ofNullable(model).orElse("").toLowerCase();
    if (normalizedModel.startsWith("dall-e-")) return true;
    String normalizedUrl = Optional.ofNullable(url).orElse("").toLowerCase();
    if (normalizedUrl.contains("api.openai.com")) return false;
    if (normalizedModel.equals("gpt-image-1") || normalizedModel.startsWith("gpt-image-1.")) return false;
    return true;
  }

  private boolean isUnsupportedResponseFormat(UpstreamClient.UpstreamResponse response) {
    String message = upstream.errorMessage(response.payload(), response.text()).toLowerCase();
    return response.status() == 400 && message.contains("response_format");
  }

  private boolean hasPart(List<Part> parts, String name) {
    return parts.stream().anyMatch(part -> name.equals(part.name()));
  }

  private GatewayResult callGatewayEdit(ImageTask task, Gateway gateway, String apiKey, List<LoadedReferenceImage> referenceImages, int n, int variantIndex) {
    String editPath = editPathForGateway(gateway);
    String upstreamGroup = Optional.ofNullable(gateway.upstreamGroup()).filter(s -> !s.isBlank()).orElse(groupForSize(task.size()));
    List<Part> parts = new ArrayList<>();
    parts.add(Part.text("model", task.model()));
    if (upstreamGroup != null) parts.add(Part.text("group", upstreamGroup));
    parts.add(Part.text("prompt", task.prompt()));
    parts.add(Part.text("size", task.size()));
    parts.add(Part.text("n", String.valueOf(n)));
    for (LoadedReferenceImage image : referenceImages) {
      parts.add(Part.file("image[]", image.bytes(), image.filename(), image.contentType()));
    }
    String editUrl = upstreamUrl(gateway.baseUrl(), editPath);
    if (shouldRequestUrlResponse(editUrl, task.model())) parts.add(Part.text("response_format", "url"));
    UpstreamClient.UpstreamResponse response = upstream.multipart(editUrl,
      Map.of("Authorization", "Bearer " + apiKey), parts, gateway.timeoutMs());
    if (!response.ok() && hasPart(parts, "response_format") && isUnsupportedResponseFormat(response)) {
      parts.removeIf(part -> "response_format".equals(part.name()));
      response = upstream.multipart(editUrl, Map.of("Authorization", "Bearer " + apiKey), parts, gateway.timeoutMs());
    }
    if (!response.ok()) throw UpstreamException.fromHttp(response.status(), upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status())).withDebug(editUrl, response.text());
    List<Map<String, Object>> dataList = allData(response.payload());
    if (dataList.isEmpty() || (dataList.get(0).get("b64_json") == null && dataList.get(0).get("url") == null)) {
      throw new UpstreamException("UPSTREAM_EMPTY_RESULT", "图像编辑网关没有返回结果", response.status(), true).withDebug(editUrl, response.text());
    }
    if (dataList.get(0).get("url") != null) {
      List<ExtraImage> extras = dataList.stream().skip(1)
        .map(d -> String.valueOf(d.get("url")))
        .filter(u -> !"null".equals(u) && u != null && !u.isBlank())
        .map(u -> new ExtraImage(u, null, null, null))
        .toList();
      return new GatewayResult(String.valueOf(dataList.get(0).get("url")), task.outputFormat(), null, null, null, null, null, extras);
    }
    List<StoredImage> stored = new ArrayList<>();
    for (int i = 0; i < dataList.size(); i++) {
      Map<String, Object> item = dataList.get(i);
      if (item.get("b64_json") != null) stored.add(persistGeneratedImage(task, String.valueOf(item.get("b64_json")), task.outputFormat(), variantIndex + i));
    }
    StoredImage first = stored.get(0);
    List<ExtraImage> extras = stored.stream().skip(1).map(s -> new ExtraImage(s.url(), s.storageKey(), s.sizeBytes(), s.hash())).toList();
    return new GatewayResult(first.url(), task.outputFormat(), null, null, first.storageKey(), first.sizeBytes(), first.hash(), extras);
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> firstData(Map<String, Object> payload) {
    Object data = payload.get("data");
    if (data instanceof List<?> list && !list.isEmpty() && list.get(0) instanceof Map<?, ?> map) {
      return (Map<String, Object>) map;
    }
    return null;
  }

  @SuppressWarnings("unchecked")
  private List<Map<String, Object>> allData(Map<String, Object> payload) {
    Object data = payload.get("data");
    if (data instanceof List<?> list) {
      return list.stream().filter(i -> i instanceof Map).map(i -> (Map<String, Object>) i).toList();
    }
    return List.of();
  }

  private StoredImage persistGeneratedImage(ImageTask task, String b64, String format, int variantIndex) {
    try {
      String safeFormat = List.of("png", "jpeg", "jpg", "webp").contains(format) ? format : "png";
      String extension = "jpeg".equals(safeFormat) ? "jpg" : safeFormat;
      StorageService.StoredObject stored = storage.putImage(task.id(), variantIndex, extension, Base64.getDecoder().decode(b64), mimeForExtension(extension));
      return new StoredImage(stored.storageKey(), stored.url(), stored.sizeBytes(), stored.hash());
    } catch (IOException exception) {
      StorageService.StorageException storageException = exception instanceof StorageService.StorageException typed
        ? typed
        : new StorageService.StorageException("结果存储失败: " + exception.getMessage(), exception);
      throw new RuntimeException(storageException.getMessage(), storageException);
    }
  }

  private List<MultipartFile> validateReferenceFiles(List<MultipartFile> files) {
    List<MultipartFile> clean = files.stream().filter(file -> file != null && !file.isEmpty()).toList();
    if (clean.size() > MAX_REFERENCE_IMAGES) throw AppException.badRequest("TOO_MANY_REFERENCE_IMAGES", "参考图最多上传 16 张");
    for (MultipartFile file : clean) {
      if (!isSupportedReferenceImage(file.getContentType(), file.getOriginalFilename())) {
        throw AppException.badRequest("INVALID_REFERENCE_IMAGE", "参考图仅支持 PNG、JPG、WEBP");
      }
      if (file.getSize() > MAX_REFERENCE_IMAGE_BYTES) {
        throw AppException.badRequest("REFERENCE_IMAGE_TOO_LARGE", "单张参考图不能超过 50MB");
      }
    }
    return clean;
  }

  private void persistReferenceImages(String taskId, List<MultipartFile> files) {
    try {
      Path dir = Path.of(storageRoot, "references", taskId);
      Files.createDirectories(dir);
      for (int index = 0; index < files.size(); index += 1) {
        MultipartFile file = files.get(index);
        String extension = extensionForMime(file.getContentType(), file.getOriginalFilename());
        Files.write(dir.resolve(String.format("%02d.%s", index + 1, extension)), file.getBytes());
      }
    } catch (IOException exception) {
      throw AppException.unavailable("REFERENCE_STORAGE_FAILED", "参考图保存失败，请检查存储目录权限");
    }
  }

  private void cleanupReferenceImages(String taskId) {
    try {
      Path dir = Path.of(storageRoot, "references", taskId);
      if (!Files.isDirectory(dir)) return;
      try (var stream = Files.list(dir)) {
        stream.forEach(path -> {
          try {
            Files.deleteIfExists(path);
          } catch (IOException ignored) {
          }
        });
      }
      Files.deleteIfExists(dir);
    } catch (IOException ignored) {
    }
  }

  private List<LoadedReferenceImage> loadReferenceImages(String taskId) throws IOException {
    Path dir = Path.of(storageRoot, "references", taskId);
    if (!Files.isDirectory(dir)) return List.of();
    try (var stream = Files.list(dir)) {
      return stream
        .filter(path -> path.getFileName().toString().matches("(?i).*\\.(png|jpe?g|webp)$"))
        .sorted()
        .limit(MAX_REFERENCE_IMAGES)
        .map(path -> {
          try {
            String extension = extension(path.getFileName().toString());
            return new LoadedReferenceImage(path.getFileName().toString(), mimeForExtension(extension), Files.readAllBytes(path));
          } catch (IOException exception) {
            throw new RuntimeException(exception);
          }
        })
        .toList();
    }
  }

  private void recordGatewayFailure(Gateway gateway, String message, long latencyMs, String code) {
    int safeLatencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, Math.max(0L, latencyMs)));
    try {
      db.jdbc().update("""
        UPDATE "Gateway" SET
          "consecutiveFailures" = "consecutiveFailures" + 1,
          "healthStatus" = CASE
            WHEN "consecutiveFailures" + 1 >= :threshold THEN 'down'::"GatewayHealth"
            ELSE 'degraded'::"GatewayHealth"
          END,
          "disabledUntil" = CASE
            WHEN "consecutiveFailures" + 1 >= :threshold THEN CAST(:disabledUntil AS timestamp)
            ELSE NULL
          END,
          "lastCheckedAt" = now(),
          "lastFailureAt" = now(),
          "lastLatencyMs" = :latencyMs,
          "lastError" = :message,
          "updatedAt" = now()
        WHERE "id" = :id
        """, new MapSqlParameterSource()
        .addValue("id", gateway.id())
        .addValue("threshold", failureThreshold)
        .addValue("disabledUntil", java.sql.Timestamp.from(Instant.now().plusMillis(cooldownMs)), Types.TIMESTAMP)
        .addValue("latencyMs", safeLatencyMs, Types.INTEGER)
        .addValue("message", truncate(message, 1000)));
    } catch (DataAccessException exception) {
      log.warn("[gateway={}] Unable to record gateway failure code={} latencyMs={}: {}",
        gateway.id(), code, safeLatencyMs, exception.getMessage());
    }
  }

  private boolean countsAgainstGatewayHealth(UpstreamException exception) {
    if (exception == null) return true;
    return switch (exception.code()) {
      case "UPSTREAM_RESPONSE_TOO_LARGE", "UPSTREAM_EMPTY_RESULT", "INVALID_UPSTREAM_URL" -> false;
      default -> true;
    };
  }

  private boolean groupMatches(String gatewayGroup, String preferredGroup) {
    String group = gatewayGroup == null ? "" : gatewayGroup.trim();
    if (preferredGroup == null) return group.isBlank();
    return preferredGroup.equals(group);
  }

  private UpstreamException upstreamException(Throwable throwable) {
    Throwable current = throwable;
    while (current != null) {
      if (current instanceof UpstreamException upstreamException) return upstreamException;
      current = current.getCause();
    }
    return null;
  }

  private StorageService.StorageException storageException(Throwable throwable) {
    Throwable current = throwable;
    while (current != null) {
      if (current instanceof StorageService.StorageException storageException) return storageException;
      current = current.getCause();
    }
    return null;
  }

  private boolean isCooling(Gateway gateway) {
    return gateway.disabledUntil() != null && gateway.disabledUntil().isAfter(Instant.now());
  }

  private String editPathForGateway(Gateway gateway) {
    String path = Optional.ofNullable(gateway.generationPath()).orElse("/images/generations");
    if (path.contains("/images/edits")) return path;
    if (path.contains("/images/generations")) return path.replace("/images/generations", "/images/edits");
    return "/images/edits";
  }

  private String normalizeSize(String rawValue, String quality) {
    String value = cleanFormString(rawValue);
    boolean is4k = "超清(4k)".equals(quality) || "high".equals(quality);
    boolean isSquare = value.isBlank() || "自动".equals(value) || "Auto".equals(value) || "auto".equals(value) || "1:1".equals(value);
    if (isSquare) return "2048x2048";  // no 4K square supported by API
    if ("16:9".equals(value)) return is4k ? "3840x2160" : "2048x1152";
    if ("9:16".equals(value)) return is4k ? "2160x3840" : "1152x2048";
    return value;
  }

  private String normalizeQuality(String value) {
    if (value == null || value.isBlank() || "自动(2k)".equals(value) || "自动(1k)".equals(value) || "auto".equals(value)) return "medium";
    if ("高清(2k)".equals(value)) return "medium";
    if ("超清(4k)".equals(value)) return "high";
    return value;
  }

  private boolean is4kSize(String size) {
    return size != null && (size.startsWith("3840x") || size.startsWith("2160x"));
  }

  private boolean is2kSize(String size) {
    return size != null && (size.startsWith("2048x") || size.startsWith("1152x"));
  }

  private String groupForSize(String size) {
    if (is4kSize(size)) return "GPT-Image-2-4k";
    if (is2kSize(size)) return "GPT-Image-2-2k";
    return null;
  }

  private String publicStatus(String status) {
    if ("processing".equals(status)) return "running";
    if ("success".equals(status)) return "succeeded";
    return status;
  }

  private int normalizeImageCount(Integer value) {
    int count = value == null ? 1 : value;
    return Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, count));
  }

  private String partialResultMessage(int requestedCount, int returnedCount, UpstreamException lastError) {
    String suffix = lastError == null || lastError.getMessage() == null || lastError.getMessage().isBlank()
      ? ""
      : "：" + lastError.getMessage();
    return "图像网关只返回 " + returnedCount + "/" + requestedCount + " 张，正在重试补齐" + suffix;
  }

  private String cleanFormString(String value) {
    String text = value == null ? "" : value.trim();
    if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.substring(1, text.length() - 1).trim();
    }
    return text;
  }

  private String firstNonBlank(String first, String second) {
    String a = cleanFormString(first);
    if (!a.isBlank()) return a;
    return cleanFormString(second);
  }

  private String extensionForMime(String mimetype, String filename) {
    String mime = mimetype == null ? "" : mimetype.toLowerCase();
    if ("image/png".equals(mime)) return "png";
    if ("image/jpeg".equals(mime) || "image/jpg".equals(mime)) return "jpg";
    if ("image/webp".equals(mime)) return "webp";
    String extension = extension(filename);
    return List.of("png", "jpg", "jpeg", "webp").contains(extension) ? ("jpeg".equals(extension) ? "jpg" : extension) : "png";
  }

  private String extension(String filename) {
    if (filename == null || !filename.contains(".")) return "";
    return filename.substring(filename.lastIndexOf('.') + 1).toLowerCase();
  }

  private boolean isSupportedReferenceImage(String mimetype, String filename) {
    String mime = mimetype == null ? "" : mimetype.toLowerCase();
    if (List.of("image/png", "image/jpeg", "image/jpg", "image/webp").contains(mime)) return true;
    return List.of("png", "jpg", "jpeg", "webp").contains(extension(filename));
  }

  private String mimeForExtension(String extension) {
    if ("jpg".equals(extension) || "jpeg".equals(extension)) return "image/jpeg";
    if ("webp".equals(extension)) return "image/webp";
    return "image/png";
  }

  private String truncate(String value, int max) {
    if (value == null) return null;
    return value.length() <= max ? value : value.substring(0, max);
  }

  public record CreateTaskParams(String userId, String apiKeyId, String requestId, CreateImageRequest dto, List<MultipartFile> referenceFiles) {}
  private record GenerationRun(List<GatewayResult> results, UpstreamException lastError) {}
  private record ImageAttempt(int index, GatewayResult result, UpstreamException error) {}
  private record GatewayResult(String url, String format, Integer width, Integer height, String storageKey, Integer sizeBytes, String hash, List<ExtraImage> extras) {}
  private record ExtraImage(String url, String storageKey, Integer sizeBytes, String hash) {}
  private record StoredImage(String storageKey, String url, Integer sizeBytes, String hash) {}
  private record LoadedReferenceImage(String filename, String contentType, byte[] bytes) {}
}
