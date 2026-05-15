package com.gptnet.image.service;

import com.gptnet.image.dto.AdminDtos.AdminCreateUserRequest;
import com.gptnet.image.dto.AdminDtos.CallSquareTestRequest;
import com.gptnet.image.dto.AdminDtos.CreditsRequest;
import com.gptnet.image.dto.AdminDtos.GatewayRequest;
import com.gptnet.image.dto.AdminDtos.PatchUserRequest;
import com.gptnet.image.dto.AdminDtos.RedemptionCodeRequest;
import com.gptnet.image.model.Gateway;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.model.RedemptionCode;
import com.gptnet.image.model.User;
import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Ids;
import com.gptnet.image.support.Json;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AdminService {
  private static final int DEFAULT_REDEMPTION_CODE_LENGTH = 16;
  private static final int MAX_REDEMPTION_BATCH_SIZE = 500;
  private static final String DEFAULT_CALL_SQUARE_URL = "https://api.superapi.me/v1/images/generations";
  private static final String LEGACY_CALL_SQUARE_URL = "https://api.superapi.me/v1/chat/completions";
  private static final String CALL_SQUARE_CONFIG_KEY = "call_square_config";
  private static final String CALL_SQUARE_API_KEY_KEY = "call_square_api_key";
  private static final String DEFAULT_CALL_SQUARE_REQUEST_BODY = """
    {
      "model": "gpt-image-2",
      "prompt": "一张用于渠道测试的产品海报，干净背景，细节清晰",
      "size": "1024x1024",
      "quality": "low",
      "format": "png"
    }
    """;
  private static final Pattern TEXT_URL_PATTERN = Pattern.compile("https?://[^\\s\"'<>，。)\\]}]+", Pattern.CASE_INSENSITIVE);

  private final Db db;
  private final SecurityService security;
  private final AuthService auth;
  private final ImageService imageService;
  private final UpstreamClient upstream;

  public AdminService(Db db, SecurityService security, AuthService auth, ImageService imageService, UpstreamClient upstream) {
    this.db = db;
    this.security = security;
    this.auth = auth;
    this.imageService = imageService;
    this.upstream = upstream;
  }

  public Map<String, Object> summary() {
    int users = count("User", null);
    int orders = count("Order", null);
    Integer paidRevenue = db.jdbc().queryForObject("""
      SELECT COALESCE(SUM("amountCents"), 0) FROM "Order" WHERE "status" = 'paid'::"OrderStatus"
      """, Map.of(), Integer.class);
    int jobs = count("ImageTask", null);
    int activeGateways = count("Gateway", "\"enabled\" = true");
    Integer issued = db.jdbc().queryForObject("SELECT COALESCE(SUM(\"amount\"), 0) FROM \"WalletEntry\" WHERE \"amount\" > 0", Map.of(), Integer.class);
    Integer spent = db.jdbc().queryForObject("SELECT COALESCE(SUM(\"amount\"), 0) FROM \"WalletEntry\" WHERE \"amount\" < 0", Map.of(), Integer.class);
    Map<String, Object> successRate24h = successRate(java.sql.Timestamp.from(Instant.now().minusSeconds(24 * 60 * 60L)));
    Map<String, Object> successRateAll = successRate(null);
    return Maps.of(
      "users", users,
      "orders", orders,
      "paidRevenueCents", paidRevenue == null ? 0 : paidRevenue,
      "jobs", jobs,
      "activeGateways", activeGateways,
      "creditIssued", issued == null ? 0 : issued,
      "creditSpent", Math.abs(spent == null ? 0 : spent),
      "successRates", Maps.of("24h", successRate24h, "all", successRateAll),
      "gateways", db.gateways()
    );
  }

  private Map<String, Object> successRate(java.sql.Timestamp since) {
    String where = since == null ? "" : "WHERE \"createdAt\" >= :since";
    Map<String, ?> params = since == null ? Map.of() : Map.of("since", since);
    Map<String, Object> counts = db.jdbc().queryForObject("""
      SELECT
        COUNT(*) FILTER (WHERE "status" IN ('success'::"ImageTaskStatus", 'failed'::"ImageTaskStatus")) AS "completed",
        COUNT(*) FILTER (WHERE "status" = 'success'::"ImageTaskStatus") AS "succeeded",
        COUNT(*) FILTER (WHERE "status" = 'failed'::"ImageTaskStatus") AS "failed"
      FROM "ImageTask"
      """ + where, params, (rs, rowNum) -> Maps.of(
        "completed", rs.getLong("completed"),
        "succeeded", rs.getLong("succeeded"),
        "failed", rs.getLong("failed")
      ));
    long completed = ((Number) counts.get("completed")).longValue();
    long succeeded = ((Number) counts.get("succeeded")).longValue();
    return Maps.of(
      "completed", completed,
      "succeeded", succeeded,
      "failed", ((Number) counts.get("failed")).longValue(),
      "rate", completed == 0 ? 0 : Math.round((succeeded * 100.0) / completed)
    );
  }

  public Map<String, Object> usage(int rawDays) {
    int days = Math.min(Math.max(rawDays, 1), 90);
    LocalDate startDate = LocalDate.now(ZoneOffset.UTC).minusDays(days - 1L);
    Instant start = startDate.atStartOfDay().toInstant(ZoneOffset.UTC);
    List<ImageTask> tasks = db.jdbc().query("""
      SELECT * FROM "ImageTask" WHERE "createdAt" >= :start ORDER BY "createdAt"
      """, Map.of("start", java.sql.Timestamp.from(start)), db.imageTaskMapper());
    Map<String, Map<String, Object>> daily = new LinkedHashMap<>();
    for (int index = 0; index < days; index += 1) {
      String key = startDate.plusDays(index).toString();
      daily.put(key, Maps.of("date", key, "jobs", 0, "succeeded", 0, "failed", 0, "credits", 0));
    }
    Map<String, Integer> byModel = new LinkedHashMap<>();
    Map<String, int[]> byGateway = new LinkedHashMap<>(); // [jobs, succeeded, failed]
    for (ImageTask task : tasks) {
      String key = task.createdAt().atZone(ZoneOffset.UTC).toLocalDate().toString();
      Map<String, Object> item = daily.get(key);
      if (item != null) {
        item.put("jobs", ((Number) item.get("jobs")).intValue() + 1);
        if ("success".equals(task.status())) item.put("succeeded", ((Number) item.get("succeeded")).intValue() + 1);
        if ("failed".equals(task.status())) item.put("failed", ((Number) item.get("failed")).intValue() + 1);
        item.put("credits", ((Number) item.get("credits")).intValue() + task.costCredits());
      }
      byModel.merge(task.model(), 1, Integer::sum);
      String gw = task.gatewayId() == null ? "unknown" : task.gatewayId();
      int[] counts = byGateway.computeIfAbsent(gw, k -> new int[3]);
      counts[0]++;
      if ("success".equals(task.status())) counts[1]++;
      if ("failed".equals(task.status())) counts[2]++;
    }
    long completed = tasks.stream().filter(task -> List.of("success", "failed").contains(task.status())).count();
    long succeeded = tasks.stream().filter(task -> "success".equals(task.status())).count();
    int credits = tasks.stream().mapToInt(ImageTask::costCredits).sum();
    return Maps.of(
      "days", days,
      "totals", Maps.of(
        "jobs", tasks.size(),
        "succeeded", succeeded,
        "failed", completed - succeeded,
        "successRate", completed == 0 ? 0 : Math.round((succeeded * 100.0) / completed),
        "credits", credits
      ),
      "daily", new ArrayList<>(daily.values()),
      "byModel", byModel.entrySet().stream().map(e -> Maps.of("model", e.getKey(), "jobs", e.getValue())).toList(),
      "byGateway", byGateway.entrySet().stream().map(e -> Maps.of("gatewayId", e.getKey(), "jobs", e.getValue()[0], "succeeded", e.getValue()[1], "failed", e.getValue()[2])).toList()
    );
  }

  public Map<String, Object> users() {
    List<User> users = db.jdbc().query("SELECT * FROM \"User\" ORDER BY \"createdAt\" DESC", Map.of(), db.userMapper());
    return Maps.of("users", users.stream().map(auth::publicUser).toList());
  }

  @Transactional
  public Map<String, Object> createUser(User actor, HttpServletRequest request, AdminCreateUserRequest body) {
    String email = body.getEmail() == null ? "" : body.getEmail().trim().toLowerCase();
    String id = db.id();
    String status = Optional.ofNullable(body.getStatus()).filter(s -> !s.isBlank()).orElse("active");
    db.jdbc().update("""
      INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "status")
      VALUES (:id, :email, :name, :passwordHash, 'user'::"UserRole", CAST(:status AS "UserStatus"))
      """, new MapSqlParameterSource()
      .addValue("id", id)
      .addValue("email", email)
      .addValue("name", body.getName() == null || body.getName().isBlank() ? email.split("@")[0] : body.getName().trim())
      .addValue("passwordHash", security.hashPassword(body.getPassword()))
      .addValue("status", status));
    if (body.getCredits() != null && body.getCredits() > 0) {
      auth.lockUserWallet(id);
      auth.addWalletEntry(id, body.getCredits(), "admin_adjust", Ids.id(), actor.id());
    }
    audit(actor, request, "user.create", id, Maps.of("email", email, "status", status, "credits", body.getCredits() == null ? 0 : body.getCredits()));
    return Maps.of("user", auth.publicUser(db.userById(id).orElseThrow()));
  }

  @Transactional
  public Map<String, Object> patchUser(User actor, HttpServletRequest request, String id, PatchUserRequest body) {
    User current = db.userById(id).orElseThrow(() -> AppException.notFound("用户不存在"));
    String nextStatus = body.getStatus() == null ? current.status() : body.getStatus();
    if ("admin".equals(current.role()) && "active".equals(current.status()) && !"active".equals(nextStatus)) {
      if (actor.id().equals(id)) throw AppException.badRequest("SELF_ADMIN_LOCKOUT", "不能停用当前登录管理员");
      Integer activeAdminCount = db.jdbc().queryForObject("""
        SELECT count(*) FROM "User" WHERE "role" = 'admin'::"UserRole" AND "status" = 'active'::"UserStatus"
        """, Map.of(), Integer.class);
      if (activeAdminCount != null && activeAdminCount <= 1) throw AppException.badRequest("LAST_ADMIN", "至少保留一个可用管理员账号");
    }
    db.jdbc().update("""
      UPDATE "User" SET "status" = CAST(:status AS "UserStatus"), "updatedAt" = now()
      WHERE "id" = :id
      """, Map.of("id", id, "status", nextStatus));
    audit(actor, request, "user.update", id, Maps.of("status", nextStatus));
    return Maps.of("user", auth.publicUser(db.userById(id).orElseThrow()));
  }

  @Transactional
  public Map<String, Object> credits(User actor, HttpServletRequest request, CreditsRequest body) {
    if (body.getUserId() == null || body.getAmount() == null) {
      throw AppException.badRequest("VALIDATION_FAILED", "用户和积分不能为空");
    }
    db.userById(body.getUserId()).orElseThrow(() -> AppException.notFound("用户不存在"));
    auth.lockUserWallet(body.getUserId());
    String ref = Ids.id();
    auth.addWalletEntry(body.getUserId(), body.getAmount(), "admin_adjust", ref, actor.id());
    audit(actor, request, "credits.change", body.getUserId(), Maps.of("amount", body.getAmount(), "reason", Optional.ofNullable(body.getReason()).orElse("admin_adjust")));
    return Maps.of("user", auth.publicUser(db.userById(body.getUserId()).orElseThrow(() -> AppException.notFound("用户不存在"))));
  }

  public Map<String, Object> gateways() {
    return Maps.of("gateways", db.gateways().stream().map(this::publicGateway).toList());
  }

  @Transactional
  public Map<String, Object> createGateway(User actor, HttpServletRequest request, GatewayRequest body) {
    String name = Optional.ofNullable(body.getName()).orElse("").trim();
    if (name.isBlank()) throw AppException.badRequest("VALIDATION_FAILED", "渠道名称不能为空");
    String id = db.id();
    String secret = Optional.ofNullable(body.getApiKey()).orElse("").trim();
    validateGatewayInput(body, secret);
    db.jdbc().update("""
      INSERT INTO "Gateway" (
        "id", "name", "provider", "baseUrl", "apiKeyEnv", "apiKeyCiphertext", "healthCheckPath",
        "generationPath", "upstreamGroup", "model", "costCredits", "timeoutMs", "enabled", "priority"
      )
      VALUES (
        :id, :name, CAST(:provider AS "GatewayProvider"), :baseUrl, NULL, :apiKeyCiphertext, :healthCheckPath,
        :generationPath, :upstreamGroup, :model, :costCredits, :timeoutMs, :enabled, :priority
      )
      """, gatewayParams(id, body)
      .addValue("name", name)
      .addValue("apiKeyCiphertext", secret.isBlank() ? null : security.encryptSecret(secret)));
    Gateway gateway = db.gatewayById(id).orElseThrow();
    audit(actor, request, "gateway.create", id, Maps.of("name", gateway.name(), "provider", gateway.provider(), "model", gateway.model()));
    return Maps.of("gateway", publicGateway(gateway));
  }

  @Transactional
  public Map<String, Object> patchGateway(User actor, HttpServletRequest request, String id, GatewayRequest body) {
    Gateway current = db.gatewayById(id).orElseThrow(() -> AppException.notFound("渠道不存在"));
    String incomingSecret = body.getApiKey() == null ? null : body.getApiKey().trim();
    validateGatewayInput(body, incomingSecret);
    MapSqlParameterSource params = gatewayParams(id, body)
      .addValue("name", Optional.ofNullable(body.getName()).filter(s -> !s.isBlank()).orElse(current.name()))
      .addValue("provider", Optional.ofNullable(body.getProvider()).filter(s -> !s.isBlank()).orElse(current.provider()))
      .addValue("baseUrl", Optional.ofNullable(body.getBaseUrl()).filter(s -> !s.isBlank()).orElse(current.baseUrl()))
      .addValue("healthCheckPath", normalizePath(body.getHealthCheckPath(), current.healthCheckPath(), "/models"))
      .addValue("generationPath", normalizePath(body.getGenerationPath(), current.generationPath(), "/images/generations"))
      .addValue("upstreamGroup", body.getUpstreamGroup() == null ? current.upstreamGroup() : blankToNull(body.getUpstreamGroup()))
      .addValue("model", Optional.ofNullable(body.getModel()).filter(s -> !s.isBlank()).orElse(current.model()))
      .addValue("costCredits", body.getCostCredits() == null ? current.costCredits() : body.getCostCredits())
      .addValue("timeoutMs", body.getTimeoutMs() == null ? current.timeoutMs() : body.getTimeoutMs())
      .addValue("enabled", body.getEnabled() == null ? current.enabled() : body.getEnabled())
      .addValue("priority", body.getPriority() == null ? current.priority() : body.getPriority())
      .addValue("healthStatus", Optional.ofNullable(body.getHealthStatus()).filter(s -> !s.isBlank()).orElse(current.healthStatus()))
      .addValue("consecutiveFailures", body.getConsecutiveFailures() == null ? current.consecutiveFailures() : body.getConsecutiveFailures());
    if (body.getApiKey() == null) {
      params.addValue("apiKeyCiphertext", current.apiKeyCiphertext());
    } else {
      String secret = body.getApiKey().trim();
      params.addValue("apiKeyCiphertext", isMaskedSecret(secret) ? current.apiKeyCiphertext() : (secret.isBlank() ? null : security.encryptSecret(secret)));
    }
    db.jdbc().update("""
      UPDATE "Gateway" SET
        "name" = :name,
        "provider" = CAST(:provider AS "GatewayProvider"),
        "baseUrl" = :baseUrl,
        "apiKeyEnv" = NULL,
        "apiKeyCiphertext" = :apiKeyCiphertext,
        "healthCheckPath" = :healthCheckPath,
        "generationPath" = :generationPath,
        "upstreamGroup" = :upstreamGroup,
        "model" = :model,
        "costCredits" = :costCredits,
        "timeoutMs" = :timeoutMs,
        "enabled" = :enabled,
        "priority" = :priority,
        "healthStatus" = CAST(:healthStatus AS "GatewayHealth"),
        "consecutiveFailures" = :consecutiveFailures,
        "updatedAt" = now()
      WHERE "id" = :id
      """, params);
    audit(actor, request, "gateway.update", id, publicPatchBody(body));
    return Maps.of("gateway", publicGateway(db.gatewayById(id).orElseThrow()));
  }

  @Transactional
  public Map<String, Object> deleteGateway(User actor, HttpServletRequest request, String id) {
    Gateway gateway = db.gatewayById(id).orElseThrow(() -> AppException.notFound("渠道不存在"));
    Integer attached = db.jdbc().queryForObject("""
      SELECT count(*) FROM "ImageTask" WHERE "gatewayId" = :id AND "status" IN ('queued'::"ImageTaskStatus", 'processing'::"ImageTaskStatus")
      """, Map.of("id", id), Integer.class);
    if (attached != null && attached > 0) throw AppException.badRequest("GATEWAY_IN_USE", "该渠道仍有进行中的任务，暂时不能删除");
    db.jdbc().update("DELETE FROM \"Gateway\" WHERE \"id\" = :id", Map.of("id", id));
    audit(actor, request, "gateway.delete", id, Maps.of("name", gateway.name(), "provider", gateway.provider(), "model", gateway.model()));
    return Maps.of("ok", true, "id", id);
  }

  public Map<String, Object> health(User actor, HttpServletRequest request, String id) {
    Gateway gateway = db.gatewayById(id).orElseThrow(() -> AppException.notFound("渠道不存在"));
    long started = System.currentTimeMillis();
    String apiKey = imageService.resolveGatewayApiKey(gateway, false);
    String keyError = gateway.apiKeyCiphertext() != null ? "渠道 API Key 无法解密，请重新保存该渠道密钥" : "渠道 API Key 未配置";
    if (apiKey == null) {
      Gateway updated = updateGatewayHealth(id, "degraded", false, started, keyError);
      audit(actor, request, "gateway.health_check", id, Maps.of("ok", false, "error", keyError, "latencyMs", System.currentTimeMillis() - started));
      return Maps.of("gateway", publicGateway(updated), "ok", false, "latencyMs", System.currentTimeMillis() - started, "error", keyError);
    }
    try {
      String path = Optional.ofNullable(gateway.healthCheckPath()).filter(s -> !s.isBlank()).orElse("/models");
      boolean useChatPing = path.contains("chat/completions");
      Map<String, Object> body = null;
      if (useChatPing) {
        body = Maps.of(
          "model", gateway.model(),
          "messages", List.of(Maps.of("role", "user", "content", "ping")),
          "stream", false
        );
        if (gateway.upstreamGroup() != null && !gateway.upstreamGroup().isBlank()) body.put("group", gateway.upstreamGroup());
      }
      var response = upstream.json(imageService.upstreamUrl(gateway.baseUrl(), path), useChatPing ? "POST" : "GET",
        Map.of("Authorization", "Bearer " + apiKey), body, Math.min(gateway.timeoutMs(), 10000));
      if (!response.ok()) throw new RuntimeException(upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status()));
      Gateway updated = updateGatewayHealth(id, "healthy", true, started, null);
      audit(actor, request, "gateway.health_check", id, Maps.of("ok", true, "latencyMs", System.currentTimeMillis() - started));
      return Maps.of("gateway", publicGateway(updated), "ok", true, "latencyMs", System.currentTimeMillis() - started);
    } catch (Exception exception) {
      String message = exception.getMessage() == null ? String.valueOf(exception) : exception.getMessage();
      Gateway updated = updateGatewayHealth(id, "degraded", false, started, message);
      audit(actor, request, "gateway.health_check", id, Maps.of("ok", false, "error", message, "latencyMs", System.currentTimeMillis() - started));
      return Maps.of("gateway", publicGateway(updated), "ok", false, "latencyMs", System.currentTimeMillis() - started, "error", message);
    }
  }

  public Map<String, Object> healthAll(User actor, HttpServletRequest request) {
    List<Map<String, Object>> results = new ArrayList<>();
    for (Gateway gateway : db.gateways()) results.add(health(actor, request, gateway.id()));
    audit(actor, request, "gateway.health_check_all", "gateways", Maps.of("total", results.size(), "ok", results.stream().filter(item -> Boolean.TRUE.equals(item.get("ok"))).count()));
    return Maps.of("results", results);
  }

  public Map<String, Object> callSquareTest(User actor, HttpServletRequest request, CallSquareTestRequest body) {
    String baseUrl = firstNonBlank(body.getUrl(), body.getBaseUrl()).trim();
    String apiKey = Optional.ofNullable(body.getApiKey()).orElse("").trim();
    String requestUrl = baseUrl;
    String upstreamGroup = blankToNull(body.getUpstreamGroup());
    int timeoutMs = Math.min(Math.max(body.getTimeoutMs() == null ? 90000 : body.getTimeoutMs(), 1000), 600000);
    if (baseUrl.isBlank()) throw AppException.badRequest("VALIDATION_FAILED", "URL 不能为空");
    if (!baseUrl.matches("(?i)^https?://.+")) throw AppException.badRequest("INVALID_CALL_SQUARE_URL", "URL 必须是 http:// 或 https:// 地址");
    boolean maskedApiKey = isMaskedSecret(apiKey);
    if (apiKey.isBlank() || maskedApiKey) {
      String savedApiKey = savedCallSquareApiKey();
      if (savedApiKey != null && !savedApiKey.isBlank()) apiKey = savedApiKey;
      else if (maskedApiKey) apiKey = "";
    }
    if (apiKey.isBlank()) throw AppException.badRequest("VALIDATION_FAILED", "API Key 不能为空");
    if (apiKey.matches("(?i)^https?://.*")) throw AppException.badRequest("INVALID_CALL_SQUARE_API_KEY", "API Key 不能填写 URL");
    Map<String, Object> upstreamBody = callSquareRequestBody(body);
    if (upstreamGroup != null) upstreamBody.put("group", upstreamGroup);
    String model = callSquareString(upstreamBody, "model", body.getModel());
    String prompt = callSquareString(upstreamBody, "prompt", body.getPrompt());
    String size = callSquareString(upstreamBody, "size", body.getSize());
    String quality = callSquareString(upstreamBody, "quality", body.getQuality());
    String outputFormat = callSquareString(upstreamBody, "format", callSquareString(upstreamBody, "output_format", body.getOutputFormat()));
    if (prompt.length() > 8000) throw AppException.badRequest("PROMPT_TOO_LONG", "提示词不能超过 8000 个字");
    if (outputFormat.isBlank()) outputFormat = "png";

    long started = System.currentTimeMillis();
    try {
      var response = upstream.json(requestUrl, "POST", Map.of("Authorization", "Bearer " + apiKey), upstreamBody, timeoutMs);
      int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
      Map<String, Object> image = firstImageResult(response.payload(), outputFormat);
      String error = response.ok() ? null : upstream.errorMessage(response.payload(), "上游返回 HTTP " + response.status());
      boolean ok = response.ok() && image != null;
      if (response.ok() && image == null) error = "上游没有返回图片结果";
      Map<String, Object> result = Maps.of(
        "ok", ok,
        "status", response.status(),
        "latencyMs", latencyMs,
        "url", requestUrl,
        "model", model,
        "prompt", prompt,
        "size", size,
        "quality", quality,
        "requestBody", upstreamBody,
        "image", image,
        "error", error,
        "rawPreview", truncate(response.text(), 2400)
      );
      audit(actor, request, "call_square.test", model.isBlank() ? "custom-request" : model, Maps.of(
        "ok", ok,
        "status", response.status(),
        "latencyMs", latencyMs,
        "url", safeEndpointForAudit(baseUrl),
        "model", model,
        "requestUrl", safeEndpointForAudit(requestUrl),
        "size", size,
        "requestBodyPreview", truncate(jsonPreview(upstreamBody), 1200),
        "hasImage", image != null
      ));
      return result;
    } catch (Exception exception) {
      int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
      String message = exception.getMessage() == null ? String.valueOf(exception) : exception.getMessage();
      audit(actor, request, "call_square.test", model.isBlank() ? "custom-request" : model, Maps.of(
        "ok", false,
        "status", 0,
        "latencyMs", latencyMs,
        "url", safeEndpointForAudit(baseUrl),
        "model", model,
        "requestUrl", safeEndpointForAudit(requestUrl),
        "size", size,
        "requestBodyPreview", truncate(jsonPreview(upstreamBody), 1200),
        "error", truncate(message, 500)
      ));
      return Maps.of(
        "ok", false,
        "status", 0,
        "latencyMs", latencyMs,
        "url", requestUrl,
        "model", model,
        "prompt", prompt,
        "size", size,
        "quality", quality,
        "requestBody", upstreamBody,
        "image", null,
        "error", message,
        "rawPreview", ""
      );
    }
  }

  public Map<String, Object> getCallSquareConfig() {
    Map<String, String> stored = siteSettings(CALL_SQUARE_CONFIG_KEY, CALL_SQUARE_API_KEY_KEY);
    Map<String, Object> config = jsonMap(stored.get(CALL_SQUARE_CONFIG_KEY));
    String secret = security.decryptSecret(stored.get(CALL_SQUARE_API_KEY_KEY));
    String requestBody = stringConfig(config, "requestBody", "");
    if (requestBody.isBlank()) requestBody = legacyCallSquareRequestBody(config);
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("url", normalizeCallSquareConfigUrl(stringConfig(config, "url", DEFAULT_CALL_SQUARE_URL)));
    result.put("upstreamGroup", stringConfig(config, "upstreamGroup", ""));
    result.put("requestBody", requestBody);
    result.put("timeoutMs", intConfig(config, "timeoutMs", 90000));
    result.put("apiKey", secret == null ? "" : security.maskSecret(secret));
    result.put("apiKeyConfigured", secret != null && !secret.isBlank());
    return Maps.of("config", result);
  }

  public Map<String, Object> saveCallSquareConfig(User actor, HttpServletRequest request, CallSquareTestRequest body) {
    String url = firstNonBlank(body.getUrl(), body.getBaseUrl()).trim();
    String apiKey = Optional.ofNullable(body.getApiKey()).orElse("").trim();
    String upstreamGroup = Optional.ofNullable(body.getUpstreamGroup()).orElse("").trim();
    int timeoutMs = Math.min(Math.max(body.getTimeoutMs() == null ? 90000 : body.getTimeoutMs(), 1000), 600000);
    if (url.isBlank()) throw AppException.badRequest("VALIDATION_FAILED", "URL 不能为空");
    if (!url.matches("(?i)^https?://.+")) throw AppException.badRequest("INVALID_CALL_SQUARE_URL", "URL 必须是 http:// 或 https:// 地址");
    if (!apiKey.isBlank() && apiKey.matches("(?i)^https?://.*")) throw AppException.badRequest("INVALID_CALL_SQUARE_API_KEY", "API Key 不能填写 URL");
    Map<String, Object> parsedBody = callSquareRequestBody(body);
    String model = callSquareString(parsedBody, "model", body.getModel());
    String prompt = callSquareString(parsedBody, "prompt", body.getPrompt());
    if (!prompt.isBlank() && prompt.length() > 8000) throw AppException.badRequest("PROMPT_TOO_LONG", "提示词不能超过 8000 个字");
    String requestBody = jsonPreview(parsedBody);

    Map<String, Object> config = Maps.of(
      "url", url,
      "upstreamGroup", upstreamGroup,
      "requestBody", requestBody,
      "timeoutMs", timeoutMs
    );
    try {
      saveSiteSetting(CALL_SQUARE_CONFIG_KEY, Json.MAPPER.writeValueAsString(config));
    } catch (Exception exception) {
      throw AppException.badRequest("CONFIG_SAVE_FAILED", "调用配置保存失败");
    }
    if (!apiKey.isBlank() && !isMaskedSecret(apiKey)) {
      saveSiteSetting(CALL_SQUARE_API_KEY_KEY, security.encryptSecret(apiKey));
    }
    audit(actor, request, "call_square.config.save", model.isBlank() ? "custom-request" : model, Maps.of(
      "url", safeEndpointForAudit(url),
      "model", model,
      "hasApiKey", !apiKey.isBlank(),
      "upstreamGroup", upstreamGroup,
      "requestBodyPreview", truncate(requestBody, 1200)
    ));
    return getCallSquareConfig();
  }

  public Map<String, Object> jobs(int rawLimit) {
    int limit = Math.min(Math.max(rawLimit, 1), 500);
    List<ImageTask> tasks = db.recentTasks(limit).stream().map(db::hydrateTask).toList();
    Instant now = Instant.now();
    return Maps.of("jobs", tasks.stream().map(task -> {
      Map<String, Object> timing = taskTiming(task, now);
      Map<String, Object> item = Maps.of(
        "id", task.id(),
        "userId", task.userId(),
        "apiKeyId", task.apiKeyId(),
        "gatewayId", task.gatewayId(),
        "requestId", task.requestId(),
        "model", task.model(),
        "prompt", task.prompt(),
        "size", task.size(),
        "quality", task.quality(),
        "outputFormat", task.outputFormat(),
        "background", task.background(),
        "imageCount", task.imageCount(),
        "status", adminStatus(task.status()),
        "errorCode", task.errorCode(),
        "errorMessage", task.errorMessage(),
        "requestUrl", task.requestUrl(),
        "rawResponse", task.rawResponse(),
        "retryCount", task.retryCount(),
        "maxRetries", task.maxRetries(),
        "costCredits", task.costCredits(),
        "latencyMs", task.latencyMs(),
        "totalLatencyMs", timing.get("totalMs"),
        "queueLatencyMs", timing.get("queueMs"),
        "processingLatencyMs", timing.get("processingMs"),
        "currentLatencyMs", timing.get("currentMs"),
        "timingPhase", timing.get("phase"),
        "timingBottleneck", timing.get("bottleneck"),
        "timingReason", timing.get("reason"),
        "timing", timing,
        "startedAt", task.startedAt(),
        "finishedAt", task.finishedAt(),
        "completedAt", task.finishedAt(),
        "createdAt", task.createdAt(),
        "updatedAt", task.updatedAt(),
        "resultUrl", task.results().isEmpty() ? null : task.results().get(0).url(),
        "userEmail", task.user() == null ? null : task.user().email(),
        "userName", task.user() == null ? null : task.user().name()
      );
      return item;
    }).toList());
  }

  private Map<String, Object> taskTiming(ImageTask task, Instant now) {
    Instant createdAt = task.createdAt();
    Instant startedAt = task.startedAt();
    Instant finishedAt = task.finishedAt();
    boolean terminal = finishedAt != null || List.of("success", "failed", "blocked", "timeout", "cancelled").contains(task.status());
    Instant effectiveEnd = finishedAt == null && !terminal ? now : finishedAt;
    Long totalMs = millisBetween(createdAt, effectiveEnd);
    Long queueMs = startedAt == null
      ? ("queued".equals(task.status()) || finishedAt != null ? millisBetween(createdAt, effectiveEnd) : null)
      : millisBetween(createdAt, startedAt);
    Long processingMs = startedAt == null ? null : millisBetween(startedAt, effectiveEnd);
    if (processingMs == null && task.latencyMs() != null) processingMs = task.latencyMs().longValue();
    Long currentMs = terminal ? null : millisBetween(createdAt, now);
    String phase = timingPhase(task, startedAt, finishedAt);
    String bottleneck = timingBottleneck(task, queueMs, processingMs);
    String reason = timingReason(task, phase, bottleneck, queueMs, processingMs);
    return Maps.of(
      "submittedAt", createdAt,
      "startedAt", startedAt,
      "returnedAt", finishedAt,
      "totalMs", totalMs,
      "queueMs", queueMs,
      "processingMs", processingMs,
      "currentMs", currentMs,
      "phase", phase,
      "bottleneck", bottleneck,
      "reason", reason,
      "retryCount", task.retryCount(),
      "maxRetries", task.maxRetries(),
      "errorCode", task.errorCode(),
      "hasResult", task.results() != null && !task.results().isEmpty()
    );
  }

  private Long millisBetween(Instant start, Instant end) {
    if (start == null || end == null || end.isBefore(start)) return null;
    return Duration.between(start, end).toMillis();
  }

  private String timingPhase(ImageTask task, Instant startedAt, Instant finishedAt) {
    if ("queued".equals(task.status()) && startedAt == null) return "queued";
    if ("processing".equals(task.status()) || ("queued".equals(task.status()) && startedAt != null && finishedAt == null)) return "processing";
    if ("success".equals(task.status())) return "completed";
    if ("failed".equals(task.status())) return "failed";
    if ("blocked".equals(task.status())) return "blocked";
    if ("timeout".equals(task.status())) return "timeout";
    if ("cancelled".equals(task.status())) return "cancelled";
    return task.status() == null ? "unknown" : task.status();
  }

  private String timingBottleneck(ImageTask task, Long queueMs, Long processingMs) {
    String code = task.errorCode() == null ? "" : task.errorCode().toUpperCase();
    if (code.contains("QUEUE")) return "queue";
    if (code.contains("GATEWAY")) return "gateway";
    if (code.contains("STORAGE")) return "storage";
    if (code.contains("TIMEOUT")) return "timeout";
    if (code.contains("UPSTREAM") || code.contains("HTTP") || code.contains("NETWORK")) return "upstream";
    if (task.retryCount() > 0) return "retry";
    long q = queueMs == null ? 0 : queueMs;
    long p = processingMs == null ? 0 : processingMs;
    if (q > 5000 && q >= p) return "queue";
    if (p > 0) return "upstream";
    return "unknown";
  }

  private String timingReason(ImageTask task, String phase, String bottleneck, Long queueMs, Long processingMs) {
    String code = task.errorCode() == null ? "" : task.errorCode().toUpperCase();
    if ("queued".equals(phase)) return "等待 worker 或上游并发名额";
    if ("processing".equals(phase)) return "上游正在生成或结果正在写入";
    if (code.contains("QUEUE_OVERLOADED")) return "队列已满，提交后无法入队";
    if (code.contains("QUEUE")) return "队列不可用或入队失败";
    if (code.contains("GATEWAY_UNAVAILABLE")) return "渠道停用、冷却或不可调度";
    if (code.contains("STORAGE")) return "图片返回后本地/对象存储失败";
    if (code.contains("TIMEOUT")) return "上游响应超时";
    if (code.contains("UPSTREAM_EMPTY")) return "上游成功响应但没有图片结果";
    if (code.contains("UPSTREAM") || code.contains("HTTP") || code.contains("NETWORK")) return "上游接口错误或网络异常";
    if (task.retryCount() > 0) return "经历重试，耗时包含退避等待";
    if ("queue".equals(bottleneck)) return "主要耗时在排队等待";
    if ("upstream".equals(bottleneck) && processingMs != null) return "主要耗时在上游生成和结果持久化";
    if ("completed".equals(phase)) return "正常完成";
    if ("failed".equals(phase)) return "失败原因见错误码和错误信息";
    return "暂无足够分段信息";
  }

  public Map<String, Object> gallery(int rawLimit, int rawOffset) {
    int limit = Math.min(Math.max(rawLimit, 1), 500);
    int maxItems = 3000;
    Integer totalValue = db.jdbc().queryForObject("""
      SELECT COUNT(*)
      FROM "ImageResult" r
      JOIN "ImageTask" t ON t."id" = r."taskId"
      """, Map.of(), Integer.class);
    int total = Math.min(totalValue == null ? 0 : totalValue, maxItems);
    int maxOffset = total == 0 ? 0 : ((total - 1) / limit) * limit;
    int offset = Math.min(Math.max(rawOffset, 0), maxOffset);
    List<Map<String, Object>> images = db.jdbc().query("""
      SELECT
        r."id",
        r."taskId",
        r."url",
        r."thumbnailUrl",
        r."storageKey",
        r."width",
        r."height",
        r."format",
        r."sizeBytes",
        r."hash",
        r."createdAt",
        t."userId",
        t."apiKeyId",
        t."gatewayId",
        t."requestId",
        t."model",
        t."prompt",
        t."size",
        t."quality",
        t."imageCount",
        t."status",
        t."costCredits",
        t."latencyMs",
        t."createdAt" AS "taskCreatedAt",
        t."finishedAt" AS "taskFinishedAt",
        u."email" AS "userEmail",
        u."name" AS "userName"
      FROM "ImageResult" r
      JOIN "ImageTask" t ON t."id" = r."taskId"
      LEFT JOIN "User" u ON u."id" = t."userId"
      ORDER BY r."createdAt" DESC, r."id" DESC
      LIMIT :limit OFFSET :offset
      """, Map.of("limit", limit, "offset", offset), (rs, rowNum) -> Maps.of(
        "id", rs.getString("id"),
        "taskId", rs.getString("taskId"),
        "url", rs.getString("url"),
        "thumbnailUrl", rs.getString("thumbnailUrl"),
        "storageKey", rs.getString("storageKey"),
        "width", db.integer(rs, "width"),
        "height", db.integer(rs, "height"),
        "format", rs.getString("format"),
        "sizeBytes", db.integer(rs, "sizeBytes"),
        "hash", rs.getString("hash"),
        "createdAt", db.instant(rs, "createdAt"),
        "userId", rs.getString("userId"),
        "apiKeyId", rs.getString("apiKeyId"),
        "gatewayId", rs.getString("gatewayId"),
        "requestId", rs.getString("requestId"),
        "model", rs.getString("model"),
        "prompt", rs.getString("prompt"),
        "size", rs.getString("size"),
        "quality", rs.getString("quality"),
        "imageCount", rs.getInt("imageCount"),
        "status", adminStatus(rs.getString("status")),
        "costCredits", rs.getInt("costCredits"),
        "latencyMs", db.integer(rs, "latencyMs"),
        "taskCreatedAt", db.instant(rs, "taskCreatedAt"),
        "taskFinishedAt", db.instant(rs, "taskFinishedAt"),
        "userEmail", rs.getString("userEmail"),
        "userName", rs.getString("userName")
      ));
    return Maps.of(
      "images", images,
      "limit", limit,
      "offset", offset,
      "total", total,
      "maxItems", maxItems,
      "page", total == 0 ? 0 : (offset / limit) + 1,
      "pageCount", total == 0 ? 0 : (int) Math.ceil(total / (double) limit)
    );
  }

  public Map<String, Object> auditLogs(int rawLimit) {
    int limit = Math.min(Math.max(rawLimit, 1), 500);
    List<Map<String, Object>> logs = db.jdbc().query("""
      SELECT l.*, u."email" AS "actorEmail", u."name" AS "actorName"
      FROM "AuditLog" l
      LEFT JOIN "User" u ON u."id" = l."actorId"
      ORDER BY l."createdAt" DESC
      LIMIT :limit
      """, Map.of("limit", limit), (rs, rowNum) -> Maps.of(
        "id", rs.getString("id"),
        "actorId", rs.getString("actorId"),
        "action", rs.getString("action"),
        "targetId", rs.getString("targetId"),
        "meta", jsonValue(rs.getString("meta")),
        "ip", rs.getString("ip"),
        "createdAt", db.instant(rs, "createdAt"),
        "actorEmail", rs.getString("actorEmail"),
        "actorName", rs.getString("actorName")
      ));
    return Maps.of("logs", logs);
  }

  public Map<String, Object> codes() {
    return Maps.of("codes", db.jdbc().query("SELECT * FROM \"RedemptionCode\" ORDER BY \"createdAt\" DESC", Map.of(), db.redemptionCodeMapper()));
  }

  @Transactional
  public Map<String, Object> createCode(User actor, HttpServletRequest request, RedemptionCodeRequest body) {
    int batchCount = Math.max(1, Math.min(MAX_REDEMPTION_BATCH_SIZE, body.getBatchCount() == null ? 1 : body.getBatchCount()));
    String manualCode = normalizeCode(body.getCode());
    if (batchCount > 1 && manualCode != null) {
      throw AppException.badRequest("BATCH_CODE_CONFLICT", "批量生成时请留空兑换码，由系统自动生成");
    }

    List<RedemptionCode> records = new ArrayList<>();
    for (int index = 0; index < batchCount; index += 1) {
      String code = manualCode == null ? uniqueRedemptionCode() : manualCode;
      String activityKey = normalizeActivityKey(body.getActivityKey(), code);
      String id = db.id();
      db.jdbc().update("""
        INSERT INTO "RedemptionCode" ("id", "code", "activityKey", "credits", "maxUses", "usedBy", "expiresAt", "active")
        VALUES (:id, :code, :activityKey, :credits, :maxUses, ARRAY[]::TEXT[], :expiresAt, true)
        """, new MapSqlParameterSource()
        .addValue("id", id)
        .addValue("code", code)
        .addValue("activityKey", activityKey)
        .addValue("credits", body.getCredits() == null ? 100 : body.getCredits())
        .addValue("maxUses", body.getMaxUses() == null ? 1 : body.getMaxUses())
        .addValue("expiresAt", body.getExpiresAt() == null || body.getExpiresAt().isBlank() ? null : java.sql.Timestamp.from(Instant.parse(body.getExpiresAt()))));
      RedemptionCode record = db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"id\" = :id", Map.of("id", id), db.redemptionCodeMapper()).orElseThrow();
      records.add(record);
    }

    RedemptionCode first = records.get(0);
    audit(actor, request, batchCount > 1 ? "redemption_code.batch_create" : "redemption_code.create", first.id(),
      Maps.of("count", records.size(), "codes", records.stream().map(RedemptionCode::code).toList(), "activityKey", first.activityKey(), "credits", first.credits(), "maxUses", first.maxUses()));
    return Maps.of("code", first, "codes", records);
  }

  @Transactional
  public Map<String, Object> patchCode(User actor, HttpServletRequest request, String id, RedemptionCodeRequest body) {
    RedemptionCode current = db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"id\" = :id", Map.of("id", id), db.redemptionCodeMapper())
      .orElseThrow(() -> AppException.notFound("兑换码不存在"));
    Object expiresAt = current.expiresAt() == null ? null : java.sql.Timestamp.from(current.expiresAt());
    if (body.getExpiresAt() != null && !body.getExpiresAt().isBlank()) {
      expiresAt = java.sql.Timestamp.from(Instant.parse(body.getExpiresAt()));
    }
    String nextActivityKey = normalizeActivityKey(body.getActivityKey(), current.activityKey());
    if (!nextActivityKey.equals(current.activityKey()) && !current.usedBy().isEmpty()) {
      throw AppException.badRequest("CODE_ALREADY_USED", "兑换码已有使用记录，不能修改活动标识");
    }
    db.jdbc().update("""
      UPDATE "RedemptionCode" SET
        "activityKey" = :activityKey,
        "credits" = :credits,
        "maxUses" = :maxUses,
        "expiresAt" = :expiresAt,
        "active" = :active,
        "updatedAt" = now()
      WHERE "id" = :id
      """, new MapSqlParameterSource()
      .addValue("id", id)
      .addValue("activityKey", nextActivityKey)
      .addValue("credits", body.getCredits() == null ? current.credits() : body.getCredits())
      .addValue("maxUses", body.getMaxUses() == null ? current.maxUses() : body.getMaxUses())
      .addValue("expiresAt", expiresAt)
      .addValue("active", body.getActive() == null ? current.active() : body.getActive()));
    RedemptionCode record = db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"id\" = :id", Map.of("id", id), db.redemptionCodeMapper()).orElseThrow();
    audit(actor, request, "redemption_code.update", id, publicPatchBody(body));
    return Maps.of("code", record);
  }

  private String normalizeActivityKey(String value, String fallback) {
    String raw = Optional.ofNullable(value).filter(s -> !s.isBlank()).orElse(fallback);
    return raw.trim().toUpperCase().replaceAll("[^A-Z0-9_-]", "-");
  }

  private String normalizeCode(String value) {
    if (value == null || value.isBlank()) return null;
    String code = value.trim().toUpperCase().replaceAll("[^A-Z0-9]", "");
    if (code.isBlank()) throw AppException.badRequest("INVALID_CODE", "兑换码只能包含数字和字母");
    db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"code\" = :code", Map.of("code", code), db.redemptionCodeMapper())
      .ifPresent(existing -> { throw AppException.conflict("CODE_EXISTS", "兑换码已存在，请更换一个新的代码"); });
    return code;
  }

  private String uniqueRedemptionCode() {
    for (int attempt = 0; attempt < 20; attempt += 1) {
      String code = Ids.randomBase62(DEFAULT_REDEMPTION_CODE_LENGTH).toUpperCase();
      if (db.optional("SELECT * FROM \"RedemptionCode\" WHERE \"code\" = :code", Map.of("code", code), db.redemptionCodeMapper()).isEmpty()) {
        return code;
      }
    }
    throw AppException.unavailable("CODE_GENERATION_FAILED", "兑换码生成失败，请重试");
  }

  public Map<String, Object> publicGateway(Gateway gateway) {
    String secret = security.decryptSecret(gateway.apiKeyCiphertext());
    Map<String, Object> map = Maps.of(
      "id", gateway.id(),
      "name", gateway.name(),
      "provider", gateway.provider(),
      "baseUrl", gateway.baseUrl(),
      "healthCheckPath", gateway.healthCheckPath(),
      "generationPath", gateway.generationPath(),
      "upstreamGroup", gateway.upstreamGroup(),
      "model", gateway.model(),
      "costCredits", gateway.costCredits(),
      "timeoutMs", gateway.timeoutMs(),
      "enabled", gateway.enabled(),
      "priority", gateway.priority(),
      "healthStatus", gateway.healthStatus(),
      "consecutiveFailures", gateway.consecutiveFailures(),
      "disabledUntil", gateway.disabledUntil(),
      "lastCheckedAt", gateway.lastCheckedAt(),
      "lastSuccessAt", gateway.lastSuccessAt(),
      "lastFailureAt", gateway.lastFailureAt(),
      "lastLatencyMs", gateway.lastLatencyMs(),
      "lastError", gateway.lastError(),
      "createdAt", gateway.createdAt(),
      "updatedAt", gateway.updatedAt(),
      "apiKey", secret == null ? "" : security.maskSecret(secret),
      "apiKeyConfigured", secret != null && !secret.isBlank()
    );
    return map;
  }

  public void audit(User actor, HttpServletRequest request, String action, String targetId, Object meta) {
    try {
      db.jdbc().update("""
        INSERT INTO "AuditLog" ("id", "actorId", "action", "targetId", "meta", "ip")
        VALUES (:id, :actorId, :action, :targetId, CAST(:meta AS jsonb), :ip)
        """, new MapSqlParameterSource()
        .addValue("id", db.id())
        .addValue("actorId", actor == null ? null : actor.id())
        .addValue("action", action)
        .addValue("targetId", targetId)
        .addValue("meta", Json.MAPPER.writeValueAsString(meta == null ? Map.of() : meta))
        .addValue("ip", request == null ? null : request.getRemoteAddr()));
    } catch (Exception ignored) {
    }
  }

  private Gateway updateGatewayHealth(String id, String status, boolean success, long started, String error) {
    int latencyMs = Math.toIntExact(Math.min(Integer.MAX_VALUE, System.currentTimeMillis() - started));
    if (success) {
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
        """, Map.of("id", id, "latencyMs", latencyMs));
    } else {
      db.jdbc().update("""
        UPDATE "Gateway" SET
          "healthStatus" = CAST(:status AS "GatewayHealth"),
          "consecutiveFailures" = "consecutiveFailures" + 1,
          "lastCheckedAt" = now(),
          "lastFailureAt" = now(),
          "lastLatencyMs" = :latencyMs,
          "lastError" = :error,
          "updatedAt" = now()
        WHERE "id" = :id
        """, new MapSqlParameterSource()
        .addValue("id", id)
        .addValue("status", status)
        .addValue("latencyMs", latencyMs)
        .addValue("error", truncate(error, 1000)));
    }
    return db.gatewayById(id).orElseThrow();
  }

  private MapSqlParameterSource gatewayParams(String id, GatewayRequest body) {
    return new MapSqlParameterSource()
      .addValue("id", id)
      .addValue("provider", Optional.ofNullable(body.getProvider()).filter(s -> !s.isBlank()).orElse("openai"))
      .addValue("baseUrl", Optional.ofNullable(body.getBaseUrl()).filter(s -> !s.isBlank()).orElse("https://api.openai.com/v1").trim())
      .addValue("healthCheckPath", Optional.ofNullable(body.getHealthCheckPath()).filter(s -> !s.isBlank()).orElse("/models").trim())
      .addValue("generationPath", Optional.ofNullable(body.getGenerationPath()).filter(s -> !s.isBlank()).orElse("/images/generations").trim())
      .addValue("upstreamGroup", blankToNull(body.getUpstreamGroup()))
      .addValue("model", Optional.ofNullable(body.getModel()).filter(s -> !s.isBlank()).orElse("gpt-image-2").trim())
      .addValue("costCredits", body.getCostCredits() == null ? 8 : body.getCostCredits())
      .addValue("timeoutMs", body.getTimeoutMs() == null ? 300000 : body.getTimeoutMs())
      .addValue("enabled", Boolean.TRUE.equals(body.getEnabled()))
      .addValue("priority", body.getPriority() == null ? 1 : body.getPriority());
  }

  private void validateGatewayInput(GatewayRequest body, String apiKey) {
    String baseUrl = Optional.ofNullable(body.getBaseUrl()).orElse("").trim();
    if (!baseUrl.isBlank() && !baseUrl.matches("(?i)^https?://.+")) {
      throw AppException.badRequest("INVALID_GATEWAY_BASE_URL", "Base URL 必须是 http:// 或 https:// 地址");
    }
    if (apiKey != null && !apiKey.isBlank() && !isMaskedSecret(apiKey)) {
      if (apiKey.matches("(?i)^https?://.*")) {
        throw AppException.badRequest("INVALID_GATEWAY_API_KEY", "API Key 不能填写 URL，请填写渠道提供的 sk-... 密钥");
      }
      if (apiKey.length() < 12 || apiKey.contains(" ")) {
        throw AppException.badRequest("INVALID_GATEWAY_API_KEY", "API Key 格式不正确，请填写完整渠道密钥");
      }
    }
  }

  private boolean isMaskedSecret(String value) {
    if (value == null || value.isBlank()) return false;
    return value.matches("^[*•]+$") || value.contains("****");
  }

  private String normalizePath(String incoming, String current, String fallback) {
    if (incoming == null) return current;
    String value = incoming.trim();
    return value.isBlank() ? fallback : value;
  }

  private String blankToNull(String value) {
    if (value == null) return null;
    String trimmed = value.trim();
    return trimmed.isBlank() ? null : trimmed;
  }

  private String firstNonBlank(String first, String second) {
    if (first != null && !first.isBlank()) return first;
    return Optional.ofNullable(second).orElse("");
  }

  private String normalizeCallSquareConfigUrl(String value) {
    if (LEGACY_CALL_SQUARE_URL.equalsIgnoreCase(Optional.ofNullable(value).orElse("").trim())) {
      return DEFAULT_CALL_SQUARE_URL;
    }
    return value;
  }

  private String safeEndpointForAudit(String value) {
    if (value == null) return "";
    int queryStart = value.indexOf('?');
    return queryStart >= 0 ? value.substring(0, queryStart) : value;
  }

  private Map<String, Object> callSquareRequestBody(CallSquareTestRequest body) {
    String raw = Optional.ofNullable(body.getRequestBody()).orElse("").trim();
    if (raw.isBlank()) {
      if (hasLegacyCallSquareFields(body)) return legacyCallSquareRequestBody(body);
      raw = DEFAULT_CALL_SQUARE_REQUEST_BODY;
    }
    try {
      Map<String, Object> parsed = Json.MAPPER.readValue(raw, Json.MAP);
      return new LinkedHashMap<>(parsed);
    } catch (Exception exception) {
      throw AppException.badRequest("INVALID_CALL_SQUARE_REQUEST_BODY", "请求参数必须是合法 JSON 对象");
    }
  }

  private boolean hasLegacyCallSquareFields(CallSquareTestRequest body) {
    return !Optional.ofNullable(body.getModel()).orElse("").isBlank()
      || !Optional.ofNullable(body.getPrompt()).orElse("").isBlank()
      || !Optional.ofNullable(body.getSize()).orElse("").isBlank()
      || !Optional.ofNullable(body.getQuality()).orElse("").isBlank()
      || !Optional.ofNullable(body.getOutputFormat()).orElse("").isBlank();
  }

  private String callSquareString(Map<String, Object> body, String key, String fallback) {
    Object value = body.get(key);
    if (value == null) return Optional.ofNullable(fallback).orElse("").trim();
    return String.valueOf(value).trim();
  }

  private Map<String, Object> legacyCallSquareRequestBody(CallSquareTestRequest body) {
    Map<String, Object> requestBody = new LinkedHashMap<>();
    requestBody.put("model", Optional.ofNullable(body.getModel()).filter(s -> !s.isBlank()).orElse("gpt-image-2").trim());
    requestBody.put("prompt", Optional.ofNullable(body.getPrompt()).filter(s -> !s.isBlank()).orElse("一张用于渠道测试的产品海报，干净背景，细节清晰").trim());
    requestBody.put("size", Optional.ofNullable(body.getSize()).filter(s -> !s.isBlank()).orElse("1024x1024").trim());
    requestBody.put("quality", Optional.ofNullable(body.getQuality()).filter(s -> !s.isBlank()).orElse("low").trim());
    String outputFormat = Optional.ofNullable(body.getOutputFormat()).filter(s -> !s.isBlank()).orElse("png").trim();
    requestBody.put("format", "jpg".equals(outputFormat) ? "jpeg" : outputFormat);
    return requestBody;
  }

  private String legacyCallSquareRequestBody(Map<String, Object> config) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("model", stringConfig(config, "model", "gpt-image-2"));
    body.put("prompt", stringConfig(config, "prompt", "一张用于渠道测试的产品海报，干净背景，细节清晰"));
    body.put("size", stringConfig(config, "size", "1024x1024"));
    body.put("quality", stringConfig(config, "quality", "low"));
    String outputFormat = stringConfig(config, "outputFormat", "png");
    body.put("format", "jpg".equals(outputFormat) ? "jpeg" : outputFormat);
    return jsonPreview(body);
  }

  private String jsonPreview(Object value) {
    try {
      return Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value);
    } catch (Exception exception) {
      return String.valueOf(value);
    }
  }

  private Stream<String> modelIds(Map<String, Object> payload) {
    Object data = payload.get("data");
    if (data instanceof List<?> list) {
      return list.stream()
        .map(item -> {
          if (item instanceof Map<?, ?> map && map.get("id") != null) return String.valueOf(map.get("id"));
          return null;
        })
        .filter(item -> item != null && !item.isBlank());
    }
    Object models = payload.get("models");
    if (models instanceof List<?> list) {
      return list.stream().map(String::valueOf).filter(item -> !item.isBlank());
    }
    return Stream.empty();
  }

  private Map<String, Object> firstImageResult(Map<String, Object> payload, String outputFormat) {
    return findImageResult(payload, outputFormat);
  }

  private Map<String, Object> findImageResult(Object value, String outputFormat) {
    if (value == null) return null;
    if (value instanceof Map<?, ?> map) {
      Map<String, Object> direct = directImageResult(map, outputFormat);
      if (direct != null) return direct;
      for (Object child : map.values()) {
        Map<String, Object> found = findImageResult(child, outputFormat);
        if (found != null) return found;
      }
      return null;
    }
    if (value instanceof List<?> list) {
      for (Object child : list) {
        Map<String, Object> found = findImageResult(child, outputFormat);
        if (found != null) return found;
      }
      return null;
    }
    if (value instanceof String text) {
      String trimmed = text.trim();
      if (trimmed.startsWith("data:image/")) return Maps.of("url", trimmed, "source", "data_url", "format", outputFormat);
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          Map<String, Object> found = findImageResult(Json.MAPPER.readValue(trimmed, Object.class), outputFormat);
          if (found != null) return found;
        } catch (Exception ignored) {
        }
      }
      String url = firstTextUrl(trimmed);
      if (url != null) return Maps.of("url", url, "source", "text_url", "format", outputFormat);
    }
    return null;
  }

  private Map<String, Object> directImageResult(Map<?, ?> map, String outputFormat) {
    if (map.get("b64_json") != null && !String.valueOf(map.get("b64_json")).isBlank()) {
      return dataUrlImageResult(String.valueOf(map.get("b64_json")), outputFormat, "b64_json");
    }
    Object imageUrl = map.get("image_url");
    if (imageUrl instanceof Map<?, ?> nested && nested.get("url") != null && !String.valueOf(nested.get("url")).isBlank()) {
      return Maps.of("url", String.valueOf(nested.get("url")), "source", "image_url", "format", outputFormat);
    }
    if (imageUrl instanceof String text && !text.isBlank()) {
      String url = firstTextUrl(text);
      if (url != null) return Maps.of("url", url, "source", "image_url", "format", outputFormat);
    }
    if (map.get("url") != null && !String.valueOf(map.get("url")).isBlank()) {
      return Maps.of("url", String.valueOf(map.get("url")), "source", "url", "format", outputFormat);
    }
    return null;
  }

  private Map<String, Object> dataUrlImageResult(String base64, String outputFormat, String source) {
    String format = "jpg".equals(outputFormat) ? "jpeg" : outputFormat;
    String mime = "jpeg".equals(format) ? "image/jpeg" : "image/" + format;
    return Maps.of("url", "data:" + mime + ";base64," + base64, "source", source, "format", outputFormat);
  }

  private String firstTextUrl(String text) {
    Matcher matcher = TEXT_URL_PATTERN.matcher(text);
    return matcher.find() ? matcher.group() : null;
  }

  private Object jsonValue(String raw) {
    if (raw == null || raw.isBlank()) return Map.of();
    try {
      return Json.MAPPER.readValue(raw, Json.MAP);
    } catch (Exception ignored) {
      return Map.of();
    }
  }

  private Map<String, Object> jsonMap(String raw) {
    if (raw == null || raw.isBlank()) return Map.of();
    try {
      return Json.MAPPER.readValue(raw, Json.MAP);
    } catch (Exception ignored) {
      return Map.of();
    }
  }

  private String savedCallSquareApiKey() {
    return security.decryptSecret(siteSettings(CALL_SQUARE_API_KEY_KEY).get(CALL_SQUARE_API_KEY_KEY));
  }

  private Map<String, String> siteSettings(String... keys) {
    if (keys.length == 0) return Map.of();
    List<String> wanted = List.of(keys);
    MapSqlParameterSource params = new MapSqlParameterSource().addValue("keys", wanted);
    Map<String, String> result = new LinkedHashMap<>();
    db.jdbc().query("""
      SELECT "key", "value" FROM "SiteSetting" WHERE "key" IN (:keys)
      """, params, (RowCallbackHandler) rs -> result.put(rs.getString("key"), rs.getString("value")));
    return result;
  }

  private void saveSiteSetting(String key, String value) {
    db.jdbc().update("""
      INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
      VALUES (:key, :value, now())
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
      """, Map.of("key", key, "value", value == null ? "" : value));
  }

  private String stringConfig(Map<String, Object> config, String key, String fallback) {
    Object value = config.get(key);
    if (value == null) return fallback;
    String text = String.valueOf(value).trim();
    return text.isBlank() ? fallback : text;
  }

  private int intConfig(Map<String, Object> config, String key, int fallback) {
    Object value = config.get(key);
    if (value instanceof Number number) return number.intValue();
    if (value != null) {
      try {
        return Integer.parseInt(String.valueOf(value).trim());
      } catch (NumberFormatException ignored) {
      }
    }
    return fallback;
  }

  private Map<String, Object> publicPatchBody(Object body) {
    return Json.MAPPER.convertValue(body, Json.MAP);
  }

  private String adminStatus(String status) {
    if ("success".equals(status)) return "succeeded";
    if ("processing".equals(status)) return "running";
    return status;
  }

  public Map<String, Object> getSettings() {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("buy_credits_url", "");
    db.jdbc().query("SELECT \"key\", \"value\" FROM \"SiteSetting\" WHERE \"key\" IN ('buy_credits_url')", Map.of(),
      rs -> { result.put(rs.getString("key"), rs.getString("value")); });
    return result;
  }

  public Map<String, Object> patchSettings(Map<String, String> body) {
    List<String> allowed = List.of("buy_credits_url");
    for (String key : allowed) {
      if (!body.containsKey(key)) continue;
      String value = body.get(key) == null ? "" : body.get(key).trim();
      db.jdbc().update("""
        INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
        VALUES (:key, :value, now())
        ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
        """, Map.of("key", key, "value", value));
    }
    return getSettings();
  }

  private int count(String table, String where) {
    String sql = "SELECT count(*) FROM \"" + table + "\"" + (where == null ? "" : " WHERE " + where);
    Integer value = db.jdbc().queryForObject(sql, Map.of(), Integer.class);
    return value == null ? 0 : value;
  }

  private String truncate(String value, int max) {
    if (value == null) return null;
    return value.length() <= max ? value : value.substring(0, max);
  }
}
