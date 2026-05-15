package com.gptnet.image.controller;

import com.gptnet.image.model.ImageResult;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.model.RedemptionCode;
import com.gptnet.image.model.User;
import com.gptnet.image.service.AuthService;
import com.gptnet.image.service.Db;
import com.gptnet.image.service.OutboundUrlPolicy;
import com.gptnet.image.service.QueueService;
import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import com.gptnet.image.service.AdminService;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
public class OperationsController {
  private static final int MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024;

  private final Db db;
  private final QueueService queue;
  private final AuthService auth;
  private final AdminService adminService;
  private final OutboundUrlPolicy outboundUrlPolicy;
  private final String storageRoot;
  private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

  public OperationsController(Db db, QueueService queue, AuthService auth, AdminService adminService, OutboundUrlPolicy outboundUrlPolicy, @Value("${LOCAL_STORAGE_DIR:storage}") String storageRoot) {
    this.db = db;
    this.queue = queue;
    this.auth = auth;
    this.adminService = adminService;
    this.outboundUrlPolicy = outboundUrlPolicy;
    this.storageRoot = storageRoot;
  }

  @GetMapping({"/admin", "/admin/"})
  public String admin() {
    return "forward:/admin.html";
  }

  @GetMapping({"/workspace", "/workspace/"})
  public String workspace() {
    return "forward:/workspace.html";
  }

  @GetMapping("/api/settings")
  @ResponseBody
  public Map<String, Object> publicSettings() {
    return adminService.getSettings();
  }

  @GetMapping("/api/health")
  @ResponseBody
  public Map<String, Object> health() {
    return Maps.of("ok", true, "version", "1.0.0-java", "time", Instant.now().toString());
  }

  @GetMapping("/api/ready")
  @ResponseBody
  public Map<String, Object> ready() {
    QueueService.QueueStats counts = queue.stats();
    return Maps.of(
      "ok", true,
      "store", "postgresql",
      "redis", true,
      "gateway", Maps.of(
        "distributed", true,
        "concurrency", integerEnv("IMAGE_WORKER_CONCURRENCY", 200),
        "active", counts.active(),
        "queued", counts.waiting() + counts.delayed()
      ),
      "queue", Maps.of(
        "mode", "redis",
        "waiting", counts.waiting(),
        "active", counts.active(),
        "completed", counts.completed(),
        "failed", counts.failed(),
        "delayed", counts.delayed(),
        "dead", counts.dead(),
        "localQueued", 0,
        "processed", counts.completed(),
        "recovered", counts.recovered()
      ),
      "time", Instant.now().toString()
    );
  }

  @GetMapping(value = "/api/metrics", produces = MediaType.TEXT_PLAIN_VALUE)
  @ResponseBody
  public String metrics() {
    int users = count("User", null);
    int tasks = count("ImageTask", null);
    int succeeded = count("ImageTask", "\"status\" = 'success'::\"ImageTaskStatus\"");
    int failed = count("ImageTask", "\"status\" = 'failed'::\"ImageTaskStatus\"");
    QueueService.QueueStats counts = queue.stats();
    Map<String, Integer> health = new java.util.HashMap<>();
    db.jdbc().query("""
      SELECT "healthStatus", count(*) AS count FROM "Gateway" GROUP BY "healthStatus"
      """, Map.of(), rs -> {
      health.put(rs.getString("healthStatus"), rs.getInt("count"));
    });
    Map<String, Integer> errors = new java.util.HashMap<>();
    db.jdbc().query("""
      SELECT COALESCE("errorCode", 'none') AS code, count(*) AS count
      FROM "ImageTask"
      WHERE "status" = 'failed'::"ImageTaskStatus"
      GROUP BY COALESCE("errorCode", 'none')
      """, Map.of(), rs -> {
      errors.put(rs.getString("code"), rs.getInt("count"));
    });
    List<String> errorLines = errors.entrySet().stream()
      .map(entry -> "image_task_errors_total{code=\"" + entry.getKey().replaceAll("[^A-Za-z0-9_:-]", "_") + "\"} " + entry.getValue())
      .toList();
    java.util.ArrayList<String> lines = new java.util.ArrayList<>(List.of(
      "# TYPE app_users_total gauge",
      "app_users_total " + users,
      "# TYPE image_tasks_total gauge",
      "image_tasks_total " + tasks,
      "# TYPE image_tasks_succeeded_total gauge",
      "image_tasks_succeeded_total " + succeeded,
      "# TYPE image_tasks_failed_total gauge",
      "image_tasks_failed_total " + failed,
      "# TYPE image_queue_waiting gauge",
      "image_queue_waiting " + counts.waiting(),
      "# TYPE image_queue_active gauge",
      "image_queue_active " + counts.active(),
      "# TYPE image_queue_completed_total counter",
      "image_queue_completed_total " + counts.completed(),
      "# TYPE image_queue_failed_total counter",
      "image_queue_failed_total " + counts.failed(),
      "# TYPE image_queue_delayed gauge",
      "image_queue_delayed " + counts.delayed(),
      "# TYPE image_queue_dead gauge",
      "image_queue_dead " + counts.dead(),
      "# TYPE image_queue_recovered_total counter",
      "image_queue_recovered_total " + counts.recovered()
    ));
    lines.addAll(errorLines);
    lines.addAll(List.of(
      "gateway_health_status{status=\"healthy\"} " + health.getOrDefault("healthy", 0),
      "gateway_health_status{status=\"degraded\"} " + health.getOrDefault("degraded", 0),
      "gateway_health_status{status=\"down\"} " + health.getOrDefault("down", 0),
      "gateway_health_status{status=\"unknown\"} " + health.getOrDefault("unknown", 0),
      ""
    ));
    return String.join("\n", lines);
  }

  @GetMapping("/api/openapi.json")
  @ResponseBody
  public Map<String, Object> openapi() {
    return Maps.of(
      "openapi", "3.1.0",
      "info", Maps.of("title", "GPT Image 2 Gateway API", "version", "1.0.0"),
      "paths", Maps.of(
        "/api/v1/images/generations", Maps.of("post", Maps.of("summary", "Create image generation task")),
        "/api/v1/images/generations/{taskId}", Maps.of("get", Maps.of("summary", "Get image task")),
        "/api/ready", Maps.of("get", Maps.of("summary", "Readiness probe"))
      )
    );
  }

  @GetMapping("/api/images/{taskId}/result")
  public ResponseEntity<?> result(@PathVariable String taskId, @RequestParam(name = "i", required = false) Integer variantIndex) {
    return serveImageResult(taskId, false, variantIndex);
  }

  @GetMapping("/api/images/{taskId}/download")
  public ResponseEntity<?> download(@PathVariable String taskId, @RequestParam(name = "i", required = false) Integer variantIndex) {
    return serveImageResult(taskId, true, variantIndex);
  }

  @GetMapping("/api/plans")
  @ResponseBody
  public Map<String, Object> plans() {
    return Maps.of("plans", db.jdbc().query("""
      SELECT * FROM "Plan" WHERE "active" = true ORDER BY "priceCents" ASC
      """, Map.of(), (rs, rowNum) -> Maps.of(
      "id", rs.getString("id"),
      "name", rs.getString("name"),
      "credits", rs.getInt("credits"),
      "priceCents", rs.getInt("priceCents"),
      "interval", rs.getString("interval"),
      "active", rs.getBoolean("active"),
      "createdAt", db.instant(rs, "createdAt"),
      "updatedAt", db.instant(rs, "updatedAt")
    )));
  }

  @PostMapping("/api/billing/checkout")
  @ResponseBody
  public ResponseEntity<Map<String, Object>> checkout(HttpServletRequest request, @RequestBody Map<String, Object> body) {
    User user = auth.validateSession(request);
    String planId = String.valueOf(body.getOrDefault("planId", ""));
    Map<String, Object> plan = db.jdbc().queryForObject("""
      SELECT * FROM "Plan" WHERE "id" = :id
      """, Map.of("id", planId), (rs, rowNum) -> Maps.of(
      "id", rs.getString("id"),
      "name", rs.getString("name"),
      "credits", rs.getInt("credits"),
      "priceCents", rs.getInt("priceCents"),
      "interval", rs.getString("interval"),
      "active", rs.getBoolean("active")
    ));
    String orderId = db.id();
    db.jdbc().update("""
      INSERT INTO "Order" ("id", "userId", "planId", "amountCents", "currency", "provider")
      VALUES (:id, :userId, :planId, :amountCents, 'CNY', 'manual')
      """, new MapSqlParameterSource()
      .addValue("id", orderId)
      .addValue("userId", user.id())
      .addValue("planId", planId)
      .addValue("amountCents", plan.get("priceCents")));
    Map<String, Object> payload = Maps.of(
      "error", "PAYMENT_PROVIDER_NOT_CONFIGURED",
      "message", "真实支付链路尚未配置，已创建订单但不会执行模拟支付。",
      "order", Maps.of("id", orderId, "userId", user.id(), "planId", planId, "amountCents", plan.get("priceCents"), "currency", "CNY", "provider", "manual"),
      "plan", plan
    );
    return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED).body(payload);
  }

  @PostMapping("/api/redeem")
  @ResponseBody
  @org.springframework.transaction.annotation.Transactional
  public Map<String, Object> redeem(HttpServletRequest request, @RequestBody Map<String, Object> body) {
    User user = auth.validateSession(request);
    String code = String.valueOf(body.getOrDefault("code", "")).trim().toUpperCase().replaceAll("[^A-Z0-9]", "");
    if (code.isBlank()) throw AppException.badRequest("VALIDATION_FAILED", "兑换码不能为空");
    auth.lockUserWallet(user.id());
    RedemptionCode record = db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"code\" = :code FOR UPDATE", Map.of("code", code), db.redemptionCodeMapper())
      .orElseThrow(() -> AppException.notFound("兑换码不存在"));
    if (!record.active() || record.usedBy().size() >= record.maxUses() ||
      (record.expiresAt() != null && record.expiresAt().isBefore(Instant.now()))) {
      throw AppException.badRequest("CODE_USED", "兑换码不可用");
    }
    try {
      db.jdbc().update("""
        INSERT INTO "RedemptionUse" ("id", "codeId", "userId", "activityKey")
        VALUES (:id, :codeId, :userId, :activityKey)
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("codeId", record.id())
        .addValue("userId", user.id())
        .addValue("activityKey", record.activityKey()));
    } catch (DuplicateKeyException exception) {
      throw AppException.badRequest("ACTIVITY_ALREADY_REDEEMED", "你已经兑换过该活动积分码");
    }
    db.jdbc().update("""
      UPDATE "RedemptionCode"
      SET "usedBy" = CASE
          WHEN :userId = ANY("usedBy") THEN "usedBy"
          ELSE array_append("usedBy", :userId)
        END,
        "updatedAt" = now()
      WHERE "id" = :id
      """, new MapSqlParameterSource().addValue("id", record.id()).addValue("userId", user.id()));
    auth.addWalletEntry(user.id(), record.credits(), "redeem_code", record.id(), user.id());
    return Maps.of("credits", db.walletBalance(user.id()), "added", record.credits());
  }

  private ResponseEntity<?> serveImageResult(String taskId, boolean attachment, Integer variantIndex) {
    ImageTask task = db.imageTaskById(taskId).map(db::hydrateTask).orElse(null);
    if (task == null || task.results().isEmpty()) return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
    int index = variantIndex == null ? 0 : Math.max(0, variantIndex);
    if (index >= task.results().size()) return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
    ImageResult result = task.results().get(index);
    Integer filenameVariant = task.results().size() > 1 ? index + 1 : null;
    if ((result.storageKey() == null || result.storageKey().isBlank()) && result.url() != null && result.url().matches("(?i)^https?://.*")) {
      return proxyRemoteImage(result.url(), result.format(), attachment ? downloadFilename(task.prompt(), result.format(), filenameVariant) : null);
    }
    if (result.storageKey() == null || result.storageKey().isBlank()) return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
    Path file = Path.of(storageRoot, result.storageKey());
    if (!Files.isRegularFile(file)) return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not found");
    HttpHeaders headers = new HttpHeaders();
    headers.setContentType(mediaType(result.format()));
    if (attachment) headers.setContentDisposition(contentDisposition(downloadFilename(task.prompt(), result.format(), filenameVariant)));
    return new ResponseEntity<>(new FileSystemResource(file), headers, HttpStatus.OK);
  }

  private ResponseEntity<?> proxyRemoteImage(String rawUrl, String format, String attachmentFilename) {
    return proxyRemoteImage(rawUrl, format, attachmentFilename, 0);
  }

  private ResponseEntity<?> proxyRemoteImage(String rawUrl, String format, String attachmentFilename, int redirects) {
    try {
      URI uri = outboundUrlPolicy.requirePublicHttpUrl(rawUrl);
      HttpResponse<InputStream> response = http.send(
        HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).GET().build(),
        HttpResponse.BodyHandlers.ofInputStream()
      );
      if (isRedirect(response.statusCode()) && redirects < 3) {
        String location = response.headers().firstValue("location").orElse("");
        if (!location.isBlank()) {
          URI next = uri.resolve(location);
          return proxyRemoteImage(next.toString(), format, attachmentFilename, redirects + 1);
        }
      }
      if (response.statusCode() < 200 || response.statusCode() >= 300) {
        return ResponseEntity.status(response.statusCode()).body("Remote image unavailable");
      }
      Optional<String> contentType = response.headers().firstValue("content-type");
      if (contentType.isPresent() && !contentType.orElse("").toLowerCase().startsWith("image/")) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Remote image unavailable");
      }
      Optional<String> contentLength = response.headers().firstValue("content-length");
      if (contentLength.isPresent() && Long.parseLong(contentLength.orElse("0")) > MAX_REMOTE_IMAGE_BYTES) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Remote image too large");
      }
      byte[] body;
      try (InputStream input = response.body()) {
        body = input.readNBytes(MAX_REMOTE_IMAGE_BYTES + 1);
      }
      if (body.length > MAX_REMOTE_IMAGE_BYTES) {
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Remote image too large");
      }
      HttpHeaders headers = new HttpHeaders();
      headers.setCacheControl("public, max-age=14400");
      headers.setContentType(contentType.map(MediaType::parseMediaType).orElse(mediaType(format)));
      headers.setContentLength(body.length);
      if (attachmentFilename != null) headers.setContentDisposition(contentDisposition(attachmentFilename));
      return new ResponseEntity<>(body, headers, HttpStatus.OK);
    } catch (Exception exception) {
      return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body("Remote image unavailable");
    }
  }

  private boolean isRedirect(int status) {
    return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
  }

  private String downloadFilename(String prompt, String format) {
    return downloadFilename(prompt, format, null);
  }

  private String downloadFilename(String prompt, String format, Integer variantIndex) {
    String safeFormat = List.of("png", "jpeg", "jpg", "webp").contains(format) ? format : "png";
    String stem = Normalizer.normalize(Optional.ofNullable(prompt).orElse(""), Normalizer.Form.NFKC)
      .codePoints()
      .filter(code -> Character.isLetterOrDigit(code) || code == '_' || code == '-')
      .limit(16)
      .collect(StringBuilder::new, (builder, code) -> builder.appendCodePoint(code), (left, right) -> left.append(right))
      .toString();
    if (stem.isBlank()) stem = "gpt-image";
    String suffix = variantIndex == null ? "" : "-" + variantIndex;
    return stem + suffix + "." + ("jpeg".equals(safeFormat) ? "jpg" : safeFormat);
  }

  private ContentDisposition contentDisposition(String filename) {
    String extension = filename.contains(".") ? filename.substring(filename.lastIndexOf('.') + 1) : "png";
    String fallbackStem = Normalizer.normalize(filename.replaceAll("\\.[^.]+$", ""), Normalizer.Form.NFKD)
      .replaceAll("[^\\x20-\\x7E]", "")
      .replaceAll("[^A-Za-z0-9._-]+", "-")
      .replaceAll("^-+|-+$", "");
    if (fallbackStem.isBlank()) fallbackStem = "gpt-image";
    if (fallbackStem.length() > 64) fallbackStem = fallbackStem.substring(0, 64);
    String fallback = fallbackStem + "." + extension;
    return ContentDisposition.attachment().filename(fallback).filename(filename, java.nio.charset.StandardCharsets.UTF_8).build();
  }

  private MediaType mediaType(String format) {
    return switch (Optional.ofNullable(format).orElse("png")) {
      case "jpg", "jpeg" -> MediaType.IMAGE_JPEG;
      case "webp" -> MediaType.parseMediaType("image/webp");
      default -> MediaType.IMAGE_PNG;
    };
  }

  private int count(String table, String where) {
    String sql = "SELECT count(*) FROM \"" + table + "\"" + (where == null ? "" : " WHERE " + where);
    Integer value = db.jdbc().queryForObject(sql, Map.of(), Integer.class);
    return value == null ? 0 : value;
  }

  private int integerEnv(String name, int fallback) {
    try {
      String value = System.getenv(name);
      return value == null || value.isBlank() ? fallback : Integer.parseInt(value);
    } catch (NumberFormatException ignored) {
      return fallback;
    }
  }
}
