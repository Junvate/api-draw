package com.gptnet.image.service;

import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class SensitiveWordService {
  private static final Logger log = LoggerFactory.getLogger(SensitiveWordService.class);
  private static final int MAX_RULES_PER_BATCH = 1000;
  private static final int MAX_PATTERN_LENGTH = 1000;
  private static final int MAX_MATCHED_TEXT_LENGTH = 200;
  private static final int REGEX_FLAGS = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE | Pattern.DOTALL;
  private static final long CACHE_TTL_MS = 10_000L;

  private final Db db;
  private final TransactionTemplate alertTx;
  private volatile List<CompiledRule> activeRules = List.of();
  private volatile long activeRulesLoadedAt = 0L;

  public SensitiveWordService(Db db, PlatformTransactionManager transactionManager) {
    this.db = db;
    this.alertTx = new TransactionTemplate(transactionManager);
    this.alertTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
  }

  public void assertAllowed(String userId, String apiKeyId, String requestId, String prompt) {
    Optional<RiskMatch> match = firstMatch(prompt);
    if (match.isEmpty()) return;
    RiskMatch risk = match.get();
    recordAlert(userId, apiKeyId, requestId, prompt, risk);
    throw AppException.forbidden("PROMPT_RISK_BLOCKED", "输入内容命中平台风控规则，已禁止生成");
  }

  public Map<String, Object> rules() {
    List<Map<String, Object>> rules = db.jdbc().query("""
      SELECT r.*,
             COALESCE(COUNT(a."id"), 0) AS "alertCount",
             MAX(a."createdAt") AS "lastHitAt"
      FROM "SensitiveWordRule" r
      LEFT JOIN "RiskAlert" a ON a."ruleId" = r."id"
      GROUP BY r."id"
      ORDER BY r."createdAt" DESC
      """, Map.of(), (rs, rowNum) -> Maps.of(
        "id", rs.getString("id"),
        "name", rs.getString("name"),
        "pattern", rs.getString("pattern"),
        "enabled", rs.getBoolean("enabled"),
        "createdBy", rs.getString("createdBy"),
        "alertCount", rs.getInt("alertCount"),
        "lastHitAt", db.instant(rs, "lastHitAt"),
        "createdAt", db.instant(rs, "createdAt"),
        "updatedAt", db.instant(rs, "updatedAt")
      ));
    return Maps.of("rules", rules);
  }

  public Map<String, Object> alerts(int rawLimit) {
    int limit = Math.min(Math.max(rawLimit, 1), 500);
    List<Map<String, Object>> alerts = db.jdbc().query("""
      SELECT a.*,
             u."email" AS "userEmail",
             u."name" AS "userName",
             k."prefix" AS "apiKeyPrefix",
             r."name" AS "ruleName",
             r."enabled" AS "ruleEnabled"
      FROM "RiskAlert" a
      LEFT JOIN "User" u ON u."id" = a."userId"
      LEFT JOIN "ApiKey" k ON k."id" = a."apiKeyId"
      LEFT JOIN "SensitiveWordRule" r ON r."id" = a."ruleId"
      ORDER BY a."createdAt" DESC
      LIMIT :limit
      """, Map.of("limit", limit), (rs, rowNum) -> Maps.of(
        "id", rs.getString("id"),
        "ruleId", rs.getString("ruleId"),
        "ruleName", rs.getString("ruleName"),
        "ruleEnabled", rs.getObject("ruleEnabled") == null ? null : rs.getBoolean("ruleEnabled"),
        "rulePattern", rs.getString("rulePattern"),
        "userId", rs.getString("userId"),
        "userEmail", rs.getString("userEmail"),
        "userName", rs.getString("userName"),
        "apiKeyId", rs.getString("apiKeyId"),
        "apiKeyPrefix", rs.getString("apiKeyPrefix"),
        "requestId", rs.getString("requestId"),
        "source", rs.getString("source"),
        "prompt", rs.getString("prompt"),
        "matchedText", rs.getString("matchedText"),
        "status", rs.getString("status"),
        "createdAt", db.instant(rs, "createdAt")
      ));
    return Maps.of("alerts", alerts);
  }

  @Transactional
  public Map<String, Object> batchConfigure(String actorId, String rawPatterns, boolean replace) {
    List<String> patterns = parsePatterns(rawPatterns);
    if (patterns.isEmpty()) throw AppException.badRequest("EMPTY_SENSITIVE_RULES", "请至少填写一条敏感词正则");
    if (replace) {
      db.jdbc().update("""
        UPDATE "SensitiveWordRule" SET "enabled" = false, "updatedAt" = now()
        """, Map.of());
    }
    for (String pattern : patterns) {
      validatePattern(pattern);
      String id = db.id();
      db.jdbc().update("""
        INSERT INTO "SensitiveWordRule" ("id", "pattern", "enabled", "createdBy")
        VALUES (:id, :pattern, true, :createdBy)
        ON CONFLICT ("pattern") DO UPDATE SET
          "enabled" = true,
          "updatedAt" = now()
        """, new MapSqlParameterSource()
        .addValue("id", id)
        .addValue("pattern", pattern)
        .addValue("createdBy", actorId));
    }
    invalidateCache();
    return Maps.of("rules", rules().get("rules"), "imported", patterns.size(), "replace", replace);
  }

  @Transactional
  public Map<String, Object> patchRule(String id, String name, String pattern, Boolean enabled) {
    Map<String, Object> current = ruleById(id).orElseThrow(() -> AppException.notFound("敏感词规则不存在"));
    String nextPattern = pattern == null ? String.valueOf(current.get("pattern")) : pattern.trim();
    validatePattern(nextPattern);
    try {
      db.jdbc().update("""
        UPDATE "SensitiveWordRule" SET
          "name" = :name,
          "pattern" = :pattern,
          "enabled" = :enabled,
          "updatedAt" = now()
        WHERE "id" = :id
        """, new MapSqlParameterSource()
        .addValue("id", id)
        .addValue("name", name == null ? current.get("name") : blankToNull(name))
        .addValue("pattern", nextPattern)
        .addValue("enabled", enabled == null ? current.get("enabled") : enabled));
    } catch (DuplicateKeyException exception) {
      throw AppException.conflict("SENSITIVE_RULE_EXISTS", "敏感词规则已存在");
    }
    invalidateCache();
    return Maps.of("rule", ruleById(id).orElseThrow());
  }

  @Transactional
  public Map<String, Object> deleteRule(String id) {
    int deleted = db.jdbc().update("DELETE FROM \"SensitiveWordRule\" WHERE \"id\" = :id", Map.of("id", id));
    if (deleted == 0) throw AppException.notFound("敏感词规则不存在");
    invalidateCache();
    return Maps.of("ok", true, "id", id);
  }

  private Optional<RiskMatch> firstMatch(String prompt) {
    String text = prompt == null ? "" : prompt;
    if (text.isBlank()) return Optional.empty();
    for (CompiledRule rule : loadActiveRules()) {
      Matcher matcher = rule.compiled().matcher(text);
      if (matcher.find()) {
        String matched = matcher.group();
        return Optional.of(new RiskMatch(rule.id(), rule.name(), rule.pattern(), matched));
      }
    }
    return Optional.empty();
  }

  private List<CompiledRule> loadActiveRules() {
    long now = System.currentTimeMillis();
    List<CompiledRule> cached = activeRules;
    if (now - activeRulesLoadedAt <= CACHE_TTL_MS) return cached;
    synchronized (this) {
      if (now - activeRulesLoadedAt <= CACHE_TTL_MS) return activeRules;
      List<CompiledRule> loaded = db.jdbc().query("""
        SELECT "id", "name", "pattern"
        FROM "SensitiveWordRule"
        WHERE "enabled" = true
        ORDER BY "updatedAt" DESC
        """, Map.of(), (rs, rowNum) -> compileRule(rs.getString("id"), rs.getString("name"), rs.getString("pattern")))
        .stream()
        .flatMap(Optional::stream)
        .toList();
      activeRules = loaded;
      activeRulesLoadedAt = now;
      return loaded;
    }
  }

  private Optional<CompiledRule> compileRule(String id, String name, String pattern) {
    try {
      return Optional.of(new CompiledRule(id, name, pattern, Pattern.compile(pattern, REGEX_FLAGS)));
    } catch (PatternSyntaxException exception) {
      log.warn("Skipping invalid sensitive word rule id={} pattern={} error={}", id, pattern, exception.getMessage());
      return Optional.empty();
    }
  }

  private void recordAlert(String userId, String apiKeyId, String requestId, String prompt, RiskMatch match) {
    alertTx.executeWithoutResult(status -> db.jdbc().update("""
      INSERT INTO "RiskAlert" (
        "id", "ruleId", "userId", "apiKeyId", "requestId", "source", "prompt", "matchedText", "rulePattern"
      )
      VALUES (
        :id, :ruleId, :userId, :apiKeyId, :requestId, :source, :prompt, :matchedText, :rulePattern
      )
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("ruleId", match.ruleId())
      .addValue("userId", userId)
      .addValue("apiKeyId", apiKeyId)
      .addValue("requestId", requestId)
      .addValue("source", apiKeyId == null ? "web" : "api")
      .addValue("prompt", prompt)
      .addValue("matchedText", truncate(match.matchedText(), MAX_MATCHED_TEXT_LENGTH))
      .addValue("rulePattern", match.rulePattern())));
  }

  private Optional<Map<String, Object>> ruleById(String id) {
    return db.optional("""
      SELECT r.*,
             COALESCE(COUNT(a."id"), 0) AS "alertCount",
             MAX(a."createdAt") AS "lastHitAt"
      FROM "SensitiveWordRule" r
      LEFT JOIN "RiskAlert" a ON a."ruleId" = r."id"
      WHERE r."id" = :id
      GROUP BY r."id"
      """, Map.of("id", id), (rs, rowNum) -> Maps.of(
        "id", rs.getString("id"),
        "name", rs.getString("name"),
        "pattern", rs.getString("pattern"),
        "enabled", rs.getBoolean("enabled"),
        "createdBy", rs.getString("createdBy"),
        "alertCount", rs.getInt("alertCount"),
        "lastHitAt", db.instant(rs, "lastHitAt"),
        "createdAt", db.instant(rs, "createdAt"),
        "updatedAt", db.instant(rs, "updatedAt")
      ));
  }

  private List<String> parsePatterns(String raw) {
    Set<String> patterns = new LinkedHashSet<>();
    String text = raw == null ? "" : raw;
    String[] lines = text.split("\\R");
    for (int index = 0; index < lines.length; index += 1) {
      String line = lines[index].trim();
      if (line.isBlank() || line.startsWith("#")) continue;
      if (patterns.size() >= MAX_RULES_PER_BATCH) {
        throw AppException.badRequest("TOO_MANY_SENSITIVE_RULES", "单次最多导入 1000 条敏感词规则");
      }
      try {
        validatePattern(line);
      } catch (AppException exception) {
        throw AppException.badRequest(exception.code(), "第 " + (index + 1) + " 行：" + exception.getMessage());
      }
      patterns.add(line);
    }
    return new ArrayList<>(patterns);
  }

  private void validatePattern(String pattern) {
    if (pattern == null || pattern.isBlank()) {
      throw AppException.badRequest("INVALID_SENSITIVE_RULE", "敏感词正则不能为空");
    }
    if (pattern.length() > MAX_PATTERN_LENGTH) {
      throw AppException.badRequest("SENSITIVE_RULE_TOO_LONG", "单条正则不能超过 1000 个字符");
    }
    try {
      Pattern.compile(pattern, REGEX_FLAGS);
    } catch (PatternSyntaxException exception) {
      throw AppException.badRequest("INVALID_SENSITIVE_REGEX", "正则不合法：" + exception.getDescription());
    }
  }

  private void invalidateCache() {
    activeRulesLoadedAt = 0L;
    activeRules = List.of();
  }

  private String blankToNull(String value) {
    if (value == null) return null;
    String text = value.trim();
    return text.isBlank() ? null : text;
  }

  private String truncate(String value, int max) {
    if (value == null) return null;
    return value.length() <= max ? value : value.substring(0, max);
  }

  private record CompiledRule(String id, String name, String pattern, Pattern compiled) {}
  private record RiskMatch(String ruleId, String ruleName, String rulePattern, String matchedText) {}
}
