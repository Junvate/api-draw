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
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

@Service
public class ImageService {
  private final Db db;
  private final SecurityService security;
  private final AuthService auth;
  private final UpstreamClient upstream;
  private final QueueService queue;
  private final StorageService storage;
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
    @Value("${LOCAL_STORAGE_DIR:storage}") String storageRoot,
    @Value("${GATEWAY_FAILURE_THRESHOLD:3}") int failureThreshold,
    @Value("${GATEWAY_COOLDOWN_MS:300000}") long cooldownMs
  ) {
    this.db = db;
    this.security = security;
    this.auth = auth;
    this.upstream = upstream;
    this.queue = queue;
    this.storage = storage;
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
          NULL, '/models', '/images/generations', 'gpt-image-2', 8, 90000, true, 10
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

  @Transactional
  public ImageTask createTask(CreateTaskParams params) {
    String prompt = cleanFormString(params.dto().getPrompt()).trim();
    if (prompt.length() < 4) throw AppException.badRequest("PROMPT_TOO_SHORT", "提示词至少输入 4 个字");
    if (prompt.length() > 8000) throw AppException.badRequest("PROMPT_TOO_LONG", "提示词不能超过 8000 个字");
    String requestedModel = Optional.of(cleanFormString(params.dto().getModel())).filter(s -> !s.isBlank()).orElse("gpt-image-2");
    String requestedQuality = cleanFormString(params.dto().getQuality());
    String normalizedSize = normalizeSize(firstNonBlank(params.dto().getSize(), params.dto().getRatio()), requestedQuality);
    Gateway gateway = selectGateway(requestedModel, normalizedSize);
    int cost = is4kSize(normalizedSize) ? 8 : is2kSize(normalizedSize) ? 6 : Math.max(1, gateway.costCredits());
    auth.lockUserWallet(params.userId());
    if (db.walletBalance(params.userId()) < cost) throw AppException.badRequest("INSUFFICIENT_CREDITS", "积分不足");
    List<MultipartFile> referenceFiles = validateReferenceFiles(params.referenceFiles());
    String taskId = db.id();
    try {
      db.jdbc().update("""
        INSERT INTO "ImageTask" (
          "id", "userId", "apiKeyId", "gatewayId", "requestId", "model", "prompt", "size",
          "quality", "outputFormat", "background", "imageCount", "costCredits", "status"
        )
        VALUES (
          :id, :userId, :apiKeyId, :gatewayId, :requestId, :model, :prompt, :size,
          :quality, :outputFormat, :background, 1, :costCredits, 'queued'::"ImageTaskStatus"
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
        .addValue("costCredits", cost));
    } catch (DataIntegrityViolationException exception) {
      if (params.apiKeyId() != null && params.requestId() != null) {
        return db.imageTaskByApiKeyAndRequest(params.apiKeyId(), params.requestId()).map(db::hydrateTask).orElseThrow();
      }
      throw exception;
    }
    db.jdbc().update("""
      INSERT INTO "WalletEntry" ("id", "userId", "amount", "reason", "refId", "actorId")
      VALUES (:id, :userId, :amount, 'generation_hold'::"WalletEntryReason", :refId, :actorId)
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("userId", params.userId())
      .addValue("amount", -cost)
      .addValue("refId", taskId)
      .addValue("actorId", params.userId()));
    if (!referenceFiles.isEmpty()) persistReferenceImages(taskId, referenceFiles);
    return db.hydrateTask(db.imageTaskById(taskId).orElseThrow());
  }

  public ImageTask queueTask(ImageTask task) {
    try {
      queue.enqueue(task.id());
      return task;
    } catch (Exception exception) {
      String code = exception instanceof QueueService.QueueOverloadedException ? "QUEUE_OVERLOADED" : "QUEUE_UNAVAILABLE";
      String message = exception instanceof QueueService.QueueOverloadedException ? exception.getMessage() : "任务队列当前不可用";
      failTask(task, code, message, true);
      throw AppException.unavailable(code, message);
    }
  }

  @Transactional
  public ImageTask processTask(String taskId, int attempt, int maxAttempts) {
    ImageTask task = db.imageTaskById(taskId).map(db::hydrateTask).orElse(null);
    if (task == null || !"queued".equals(task.status())) return task;
    Gateway gateway = task.gateway();
    if (gateway == null || !gateway.enabled() || isCooling(gateway)) {
      return failTask(task, "GATEWAY_UNAVAILABLE", "任务网关当前不可用", true);
    }

    long started = System.currentTimeMillis();
    int claimed = db.jdbc().update("""
      UPDATE "ImageTask" SET "status" = 'processing'::"ImageTaskStatus", "startedAt" = now(), "updatedAt" = now()
      WHERE "id" = :id AND "status" = 'queued'::"ImageTaskStatus"
      """, Map.of("id", task.id()));
    if (claimed == 0) return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
    try {
      GatewayResult result = callGateway(task, gateway);
      int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
      db.jdbc().update("""
        INSERT INTO "ImageResult" ("id", "taskId", "url", "format", "width", "height", "storageKey", "sizeBytes", "hash")
        VALUES (:id, :taskId, :url, :format, :width, :height, :storageKey, :sizeBytes, :hash)
        ON CONFLICT ("taskId") DO UPDATE SET
          "url" = EXCLUDED."url",
          "format" = EXCLUDED."format",
          "width" = EXCLUDED."width",
          "height" = EXCLUDED."height",
          "storageKey" = EXCLUDED."storageKey",
          "sizeBytes" = EXCLUDED."sizeBytes",
          "hash" = EXCLUDED."hash",
          "createdAt" = now()
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
      db.jdbc().update("""
        INSERT INTO "UsageRecord" (
          "id", "userId", "apiKeyId", "taskId", "model", "imageCount", "costCredits", "latencyMs", "status"
        )
        VALUES (:id, :userId, :apiKeyId, :taskId, :model, :imageCount, :costCredits, :latencyMs, 'success')
        ON CONFLICT ("taskId") DO UPDATE SET "status" = 'success', "costCredits" = EXCLUDED."costCredits", "latencyMs" = EXCLUDED."latencyMs"
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("userId", task.userId())
        .addValue("apiKeyId", task.apiKeyId())
        .addValue("taskId", task.id())
        .addValue("model", task.model())
        .addValue("imageCount", task.imageCount())
        .addValue("costCredits", task.costCredits())
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
      db.jdbc().update("""
        UPDATE "ImageTask" SET "status" = 'success'::"ImageTaskStatus", "latencyMs" = :latencyMs, "finishedAt" = now(), "updatedAt" = now()
        WHERE "id" = :id
        """, Map.of("id", task.id(), "latencyMs", latencyMs));
      return db.imageTaskById(task.id()).map(db::hydrateTask).orElseThrow();
    } catch (Exception exception) {
      if (exception instanceof StorageService.StorageException || exception.getCause() instanceof StorageService.StorageException) {
        String message = exception.getMessage() == null ? "结果存储失败" : exception.getMessage();
        return failTask(task, "STORAGE_FAILED", message, true);
      }
      UpstreamException upstreamException = upstreamException(exception);
      String message = exception.getMessage() == null ? String.valueOf(exception) : exception.getMessage();
      String code = upstreamException == null ? "UPSTREAM_FAILED" : upstreamException.code();
      boolean retryable = upstreamException == null || upstreamException.retryable();
      recordGatewayFailure(gateway, message, System.currentTimeMillis() - started, code);
      if (retryable && attempt < maxAttempts) {
        db.jdbc().update("""
          UPDATE "ImageTask" SET
            "status" = 'queued'::"ImageTaskStatus",
            "retryCount" = :retryCount,
            "errorCode" = :code,
            "errorMessage" = :message,
            "updatedAt" = now()
          WHERE "id" = :id
          """, new MapSqlParameterSource()
          .addValue("id", task.id())
          .addValue("retryCount", attempt)
          .addValue("code", code)
          .addValue("message", truncate(message, 1000)));
        return db.imageTaskById(task.id()).map(db::hydrateTask).orElse(task);
      }
      return failTask(task, code, message, true);
    }
  }

  @Transactional
  public ImageTask failTask(ImageTask task, String code, String message, boolean refund) {
    auth.lockUserWallet(task.userId());
    Integer refundCount = db.jdbc().queryForObject("""
      SELECT count(*) FROM "WalletEntry" WHERE "refId" = :refId AND "reason" = 'generation_refund'::"WalletEntryReason"
      """, Map.of("refId", task.id()), Integer.class);
    if (refund && (refundCount == null || refundCount == 0)) {
      db.jdbc().update("""
        INSERT INTO "WalletEntry" ("id", "userId", "amount", "reason", "refId", "actorId")
        VALUES (:id, :userId, :amount, 'generation_refund'::"WalletEntryReason", :refId, :actorId)
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("userId", task.userId())
        .addValue("amount", task.costCredits())
        .addValue("refId", task.id())
        .addValue("actorId", task.userId()));
    }
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
    db.jdbc().update("""
      UPDATE "ImageTask" SET
        "status" = 'failed'::"ImageTaskStatus",
        "errorCode" = :code,
        "errorMessage" = :message,
        "finishedAt" = now(),
        "updatedAt" = now()
      WHERE "id" = :id
      """, new MapSqlParameterSource()
      .addValue("id", task.id())
      .addValue("code", code)
      .addValue("message", truncate(message, 1000)));
    return db.imageTaskById(task.id()).map(db::hydrateTask).orElseThrow();
  }

  public Map<String, Object> publicTask(ImageTask rawTask, String userId) {
    ImageTask task = rawTask.results().isEmpty() ? db.hydrateTask(rawTask) : rawTask;
    ImageResult first = task.results().isEmpty() ? null : task.results().get(0);
    String display = first == null ? null : "/api/images/" + task.id() + "/result";
    String download = first == null ? null : "/api/images/" + task.id() + "/download";
    List<Map<String, Object>> images = task.results().stream().map(result -> Maps.of("url", result.url())).toList();
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
      "error", task.errorMessage(),
      "cost_credits", task.costCredits(),
      "costCredits", task.costCredits(),
      "credits_remaining", db.walletBalance(userId),
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
      .toList();
    // Try preferred group first, then fall back to any available group
    return all.stream().filter(item -> groupMatches(item.upstreamGroup(), preferredGroup)).findFirst()
      .or(() -> all.stream().findFirst())
      .orElseThrow(() -> AppException.unavailable("NO_AVAILABLE_GATEWAY", "没有可用渠道，请稍后重试"));
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

  private GatewayResult callGateway(ImageTask task, Gateway gateway) throws IOException {
    String apiKey = resolveGatewayApiKey(gateway);
    List<LoadedReferenceImage> referenceImages = loadReferenceImages(task.id());
    return referenceImages.isEmpty()
      ? callGatewayGeneration(task, gateway, apiKey)
      : callGatewayEdit(task, gateway, apiKey, referenceImages);
  }

  @SuppressWarnings("unchecked")
  private GatewayResult callGatewayGeneration(ImageTask task, Gateway gateway, String apiKey) {
    String generationPath = Optional.ofNullable(gateway.generationPath()).filter(s -> !s.isBlank()).orElse("/images/generations");
    String upstreamGroup = Optional.ofNullable(gateway.upstreamGroup()).filter(s -> !s.isBlank()).orElse(groupForSize(task.size()));
    Map<String, Object> body = Maps.of(
      "model", task.model(),
      "prompt", task.prompt(),
      "size", task.size(),
      "output_format", task.outputFormat(),
      "response_format", "url",
      "background", task.background(),
      "n", task.imageCount()
    );
    if (upstreamGroup != null) body.put("group", upstreamGroup);
    UpstreamClient.UpstreamResponse response = upstream.json(upstreamUrl(gateway.baseUrl(), generationPath), "POST",
      Map.of("Authorization", "Bearer " + apiKey), body, gateway.timeoutMs());
    if (!response.ok()) throw UpstreamException.fromHttp(response.status(), upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status()));
    Map<String, Object> first = firstData(response.payload());
    if (first == null || (first.get("b64_json") == null && first.get("url") == null)) {
      throw new UpstreamException("UPSTREAM_EMPTY_RESULT", "图像网关没有返回结果", response.status(), true);
    }
    if (first.get("url") != null) return new GatewayResult(String.valueOf(first.get("url")), task.outputFormat(), null, null, null, null, null);
    StoredImage stored = persistGeneratedImage(task, String.valueOf(first.get("b64_json")), task.outputFormat());
    return new GatewayResult(stored.url(), task.outputFormat(), null, null, stored.storageKey(), stored.sizeBytes(), stored.hash());
  }

  private GatewayResult callGatewayEdit(ImageTask task, Gateway gateway, String apiKey, List<LoadedReferenceImage> referenceImages) {
    String editPath = editPathForGateway(gateway);
    String upstreamGroup = Optional.ofNullable(gateway.upstreamGroup()).filter(s -> !s.isBlank()).orElse(groupForSize(task.size()));
    List<Part> parts = new ArrayList<>();
    parts.add(Part.text("model", task.model()));
    if (upstreamGroup != null) parts.add(Part.text("group", upstreamGroup));
    parts.add(Part.text("prompt", task.prompt()));
    parts.add(Part.text("size", task.size()));
    parts.add(Part.text("response_format", "url"));
    for (LoadedReferenceImage image : referenceImages) {
      parts.add(Part.file("image", image.bytes(), image.filename(), image.contentType()));
    }
    UpstreamClient.UpstreamResponse response = upstream.multipart(upstreamUrl(gateway.baseUrl(), editPath),
      Map.of("Authorization", "Bearer " + apiKey), parts, gateway.timeoutMs());
    if (!response.ok()) throw UpstreamException.fromHttp(response.status(), upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status()));
    Map<String, Object> first = firstData(response.payload());
    if (first == null || (first.get("b64_json") == null && first.get("url") == null)) {
      throw new UpstreamException("UPSTREAM_EMPTY_RESULT", "图像编辑网关没有返回结果", response.status(), true);
    }
    if (first.get("url") != null) return new GatewayResult(String.valueOf(first.get("url")), task.outputFormat(), null, null, null, null, null);
    StoredImage stored = persistGeneratedImage(task, String.valueOf(first.get("b64_json")), task.outputFormat());
    return new GatewayResult(stored.url(), task.outputFormat(), null, null, stored.storageKey(), stored.sizeBytes(), stored.hash());
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> firstData(Map<String, Object> payload) {
    Object data = payload.get("data");
    if (data instanceof List<?> list && !list.isEmpty() && list.get(0) instanceof Map<?, ?> map) {
      return (Map<String, Object>) map;
    }
    return null;
  }

  private StoredImage persistGeneratedImage(ImageTask task, String b64, String format) {
    try {
      String safeFormat = List.of("png", "jpeg", "jpg", "webp").contains(format) ? format : "png";
      String extension = "jpeg".equals(safeFormat) ? "jpg" : safeFormat;
      StorageService.StoredObject stored = storage.putImage(task.id(), extension, Base64.getDecoder().decode(b64), mimeForExtension(extension));
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
    if (clean.size() > 3) throw AppException.badRequest("TOO_MANY_REFERENCE_IMAGES", "参考图最多上传 3 张");
    for (MultipartFile file : clean) {
      if (file.getContentType() == null || !file.getContentType().startsWith("image/")) {
        throw AppException.badRequest("INVALID_REFERENCE_IMAGE", "参考图必须是图片文件");
      }
      if (file.getSize() > 10L * 1024L * 1024L) {
        throw AppException.badRequest("REFERENCE_IMAGE_TOO_LARGE", "单张参考图不能超过 10MB");
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

  private List<LoadedReferenceImage> loadReferenceImages(String taskId) throws IOException {
    Path dir = Path.of(storageRoot, "references", taskId);
    if (!Files.isDirectory(dir)) return List.of();
    try (var stream = Files.list(dir)) {
      return stream
        .filter(path -> path.getFileName().toString().matches("(?i).*\\.(png|jpe?g|webp)$"))
        .sorted()
        .limit(3)
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
    int failures = gateway.consecutiveFailures() + 1;
    boolean hardFailure = "UPSTREAM_AUTH_FAILED".equals(code) || "INVALID_GATEWAY_API_KEY".equals(code);
    int nextFailures = hardFailure ? Math.max(failures, failureThreshold) : failures;
    db.jdbc().update("""
      UPDATE "Gateway" SET
        "healthStatus" = CAST(:healthStatus AS "GatewayHealth"),
        "consecutiveFailures" = :failures,
        "disabledUntil" = :disabledUntil,
        "lastCheckedAt" = now(),
        "lastFailureAt" = now(),
        "lastLatencyMs" = :latencyMs,
        "lastError" = :message,
        "updatedAt" = now()
      WHERE "id" = :id
      """, new MapSqlParameterSource()
      .addValue("id", gateway.id())
      .addValue("healthStatus", nextFailures >= failureThreshold ? "down" : "degraded")
      .addValue("failures", nextFailures)
      .addValue("disabledUntil", nextFailures >= failureThreshold ? java.sql.Timestamp.from(Instant.now().plusMillis(cooldownMs)) : null)
      .addValue("latencyMs", Math.min(Integer.MAX_VALUE, latencyMs))
      .addValue("message", truncate(message, 1000)));
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
    if (isSquare) return is4k ? "3840x3840" : "2048x2048";
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
  private record GatewayResult(String url, String format, Integer width, Integer height, String storageKey, Integer sizeBytes, String hash) {}
  private record StoredImage(String storageKey, String url, Integer sizeBytes, String hash) {}
  private record LoadedReferenceImage(String filename, String contentType, byte[] bytes) {}
}
