package com.gptnet.image.service;

import com.gptnet.image.model.ApiKey;
import com.gptnet.image.model.Gateway;
import com.gptnet.image.model.ImageResult;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.model.RedemptionCode;
import com.gptnet.image.model.User;
import com.gptnet.image.support.Ids;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class Db {
  private final NamedParameterJdbcTemplate jdbc;

  public Db(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public NamedParameterJdbcTemplate jdbc() {
    return jdbc;
  }

  public Optional<User> userById(String id) {
    return optional("SELECT * FROM \"User\" WHERE \"id\" = :id", Map.of("id", id), userMapper());
  }

  public Optional<User> userByEmail(String email) {
    return optional("SELECT * FROM \"User\" WHERE \"email\" = :email", Map.of("email", email), userMapper());
  }

  public Optional<ApiKey> apiKeyByHash(String keyHash) {
    return optional("SELECT * FROM \"ApiKey\" WHERE \"keyHash\" = :keyHash", Map.of("keyHash", keyHash), apiKeyMapper());
  }

  public Optional<Gateway> gatewayById(String id) {
    return optional("""
      SELECT g.*, COALESCE(array_agg(a."userId" ORDER BY u."email") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::TEXT[]) AS "exclusiveUserIds"
      FROM "Gateway" g
      LEFT JOIN "GatewayUserAccess" a ON a."gatewayId" = g."id"
      LEFT JOIN "User" u ON u."id" = a."userId"
      WHERE g."id" = :id
      GROUP BY g."id"
      """, Map.of("id", id), gatewayMapper());
  }

  public List<Gateway> gateways() {
    return jdbc.query("""
      SELECT g.*, COALESCE(array_agg(a."userId" ORDER BY u."email") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::TEXT[]) AS "exclusiveUserIds"
      FROM "Gateway" g
      LEFT JOIN "GatewayUserAccess" a ON a."gatewayId" = g."id"
      LEFT JOIN "User" u ON u."id" = a."userId"
      GROUP BY g."id"
      ORDER BY g."priority" DESC
      """, Map.of(), gatewayMapper());
  }

  public List<Gateway> enabledGatewaysForModel(String model, String userId) {
    List<Gateway> gateways = jdbc.query("""
      SELECT g.*, COALESCE(array_agg(a."userId" ORDER BY u."email") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::TEXT[]) AS "exclusiveUserIds"
      FROM "Gateway" g
      LEFT JOIN "GatewayUserAccess" a ON a."gatewayId" = g."id"
      LEFT JOIN "User" u ON u."id" = a."userId"
      WHERE g."enabled" = true
        AND g."model" = :model
        AND (
          NOT EXISTS (SELECT 1 FROM "GatewayUserAccess" any_access WHERE any_access."gatewayId" = g."id")
          OR EXISTS (
            SELECT 1 FROM "GatewayUserAccess" own_access
            WHERE own_access."gatewayId" = g."id"
              AND own_access."userId" = :userId
          )
        )
      GROUP BY g."id"
      ORDER BY g."priority" DESC
      """, Map.of("model", model, "userId", userId), gatewayMapper());
    Collections.shuffle(gateways);
    gateways.sort((left, right) -> Integer.compare(right.priority(), left.priority()));
    return gateways;
  }

  public List<Gateway> enabledGatewaysForUser(String userId) {
    return jdbc.query("""
      SELECT g.*, COALESCE(array_agg(a."userId" ORDER BY u."email") FILTER (WHERE a."userId" IS NOT NULL), ARRAY[]::TEXT[]) AS "exclusiveUserIds"
      FROM "Gateway" g
      LEFT JOIN "GatewayUserAccess" a ON a."gatewayId" = g."id"
      LEFT JOIN "User" u ON u."id" = a."userId"
      WHERE g."enabled" = true
        AND (
          NOT EXISTS (SELECT 1 FROM "GatewayUserAccess" any_access WHERE any_access."gatewayId" = g."id")
          OR EXISTS (
            SELECT 1 FROM "GatewayUserAccess" own_access
            WHERE own_access."gatewayId" = g."id"
              AND own_access."userId" = :userId
          )
        )
      GROUP BY g."id"
      ORDER BY g."priority" DESC, g."name" ASC
      """, Map.of("userId", userId), gatewayMapper());
  }

  public Optional<ImageTask> imageTaskById(String id) {
    return optional("SELECT * FROM \"ImageTask\" WHERE \"id\" = :id", Map.of("id", id), imageTaskMapper());
  }

  public Optional<ImageTask> imageTaskByIdAndUser(String id, String userId) {
    return optional("SELECT * FROM \"ImageTask\" WHERE \"id\" = :id AND \"userId\" = :userId",
      Map.of("id", id, "userId", userId), imageTaskMapper());
  }

  public Optional<ImageTask> imageTaskByApiKeyAndRequest(String apiKeyId, String requestId) {
    return optional("""
      SELECT * FROM "ImageTask"
      WHERE "apiKeyId" = :apiKeyId AND "requestId" = :requestId
      """, Map.of("apiKeyId", apiKeyId, "requestId", requestId), imageTaskMapper());
  }

  public List<ImageTask> recentTasks(Integer limit) {
    return jdbc.query("SELECT * FROM \"ImageTask\" ORDER BY \"createdAt\" DESC LIMIT :limit",
      Map.of("limit", limit), imageTaskMapper());
  }

  public List<ImageTask> recentTasksForUser(String userId, int limit) {
    return jdbc.query("""
      SELECT * FROM "ImageTask"
      WHERE "userId" = :userId
      ORDER BY "createdAt" DESC
      LIMIT :limit
      """, Map.of("userId", userId, "limit", limit), imageTaskMapper());
  }

  public List<ImageTask> pendingTasks() {
    return jdbc.query("""
      SELECT * FROM "ImageTask"
      WHERE "status" IN ('queued', 'processing')
      ORDER BY "createdAt" ASC
      """, Map.of(), imageTaskMapper());
  }

  public long pendingTaskCount() {
    Long value = jdbc.queryForObject("""
      SELECT count(*) FROM "ImageTask"
      WHERE "status" IN ('queued', 'processing')
      """, Map.of(), Long.class);
    return value == null ? 0 : value;
  }

  public List<ImageResult> resultsForTask(String taskId) {
    return jdbc.query("""
      SELECT * FROM "ImageResult"
      WHERE "taskId" = :taskId
      ORDER BY "createdAt" ASC, "id" ASC
      """, Map.of("taskId", taskId), imageResultMapper());
  }

  public ImageTask hydrateTask(ImageTask task) {
    ImageTask hydrated = task.withResults(resultsForTask(task.id()));
    if (task.userId() != null) hydrated = userById(task.userId()).map(hydrated::withUser).orElse(hydrated);
    if (task.gatewayId() != null) hydrated = gatewayById(task.gatewayId()).map(hydrated::withGateway).orElse(hydrated);
    return hydrated;
  }

  public int walletBalance(String userId) {
    Integer value = jdbc.queryForObject("SELECT COALESCE(SUM(\"amount\"), 0) FROM \"WalletEntry\" WHERE \"userId\" = :userId",
      Map.of("userId", userId), Integer.class);
    return value == null ? 0 : value;
  }

  public List<Map<String, Object>> walletHistory(String userId, int limit, int offset) {
    return jdbc.queryForList("""
      SELECT w.id, w.amount, w.reason, w.\"refId\", w.\"createdAt\",
             t.model, t.prompt, t.size, t.quality, t.status AS \"taskStatus\",
             (SELECT r.url FROM \"ImageResult\" r WHERE r.\"taskId\" = w.\"refId\" LIMIT 1) AS \"resultUrl\"
      FROM \"WalletEntry\" w
      LEFT JOIN \"ImageTask\" t ON t.id = w.\"refId\"
      WHERE w.\"userId\" = :userId
      ORDER BY w.\"createdAt\" DESC
      LIMIT :limit OFFSET :offset
      """, Map.of("userId", userId, "limit", limit, "offset", offset));
  }

  public boolean exists(String table) {
    Integer count = jdbc.queryForObject("SELECT count(*) FROM \"" + table + "\"", Map.of(), Integer.class);
    return count != null && count > 0;
  }

  public <T> Optional<T> optional(String sql, Map<String, ?> params, RowMapper<T> mapper) {
    try {
      return Optional.ofNullable(jdbc.queryForObject(sql, params, mapper));
    } catch (EmptyResultDataAccessException ignored) {
      return Optional.empty();
    }
  }

  public MapSqlParameterSource params() {
    return new MapSqlParameterSource();
  }

  public String id() {
    return Ids.id();
  }

  public RowMapper<User> userMapper() {
    return (rs, rowNum) -> new User(
      rs.getString("id"),
      rs.getString("tenantId"),
      rs.getString("email"),
      rs.getString("name"),
      rs.getString("passwordHash"),
      rs.getString("role"),
      rs.getString("status"),
      instant(rs, "createdAt"),
      instant(rs, "updatedAt")
    );
  }

  public RowMapper<ApiKey> apiKeyMapper() {
    return (rs, rowNum) -> new ApiKey(
      rs.getString("id"),
      rs.getString("userId"),
      rs.getString("name"),
      rs.getString("prefix"),
      rs.getString("keyHash"),
      stringArray(rs, "scopes"),
      rs.getString("status"),
      instant(rs, "expiresAt"),
      instant(rs, "lastUsedAt"),
      instant(rs, "createdAt"),
      instant(rs, "updatedAt")
    );
  }

  public RowMapper<Gateway> gatewayMapper() {
    return (rs, rowNum) -> new Gateway(
      rs.getString("id"),
      rs.getString("name"),
      rs.getString("provider"),
      rs.getString("baseUrl"),
      rs.getString("apiKeyEnv"),
      rs.getString("apiKeyCiphertext"),
      rs.getString("healthCheckPath"),
      rs.getString("generationPath"),
      rs.getString("upstreamGroup"),
      stringArray(rs, "exclusiveUserIds"),
      rs.getString("model"),
      rs.getInt("costCredits"),
      rs.getInt("timeoutMs"),
      rs.getBoolean("enabled"),
      rs.getInt("priority"),
      rs.getString("healthStatus"),
      rs.getInt("consecutiveFailures"),
      instant(rs, "disabledUntil"),
      instant(rs, "lastCheckedAt"),
      instant(rs, "lastSuccessAt"),
      instant(rs, "lastFailureAt"),
      integer(rs, "lastLatencyMs"),
      rs.getString("lastError"),
      instant(rs, "createdAt"),
      instant(rs, "updatedAt")
    );
  }

  public RowMapper<ImageTask> imageTaskMapper() {
    return (rs, rowNum) -> new ImageTask(
      rs.getString("id"),
      rs.getString("userId"),
      rs.getString("apiKeyId"),
      rs.getString("gatewayId"),
      rs.getString("requestId"),
      rs.getString("model"),
      rs.getString("prompt"),
      rs.getString("negativePrompt"),
      rs.getString("size"),
      rs.getString("quality"),
      rs.getString("outputFormat"),
      rs.getString("background"),
      rs.getInt("imageCount"),
      rs.getString("status"),
      rs.getString("errorCode"),
      rs.getString("errorMessage"),
      rs.getString("requestUrl"),
      rs.getString("rawResponse"),
      rs.getInt("retryCount"),
      rs.getInt("maxRetries"),
      rs.getInt("costCredits"),
      integer(rs, "latencyMs"),
      instant(rs, "startedAt"),
      instant(rs, "finishedAt"),
      instant(rs, "createdAt"),
      instant(rs, "updatedAt"),
      List.of(),
      null,
      null
    );
  }

  public RowMapper<ImageResult> imageResultMapper() {
    return (rs, rowNum) -> new ImageResult(
      rs.getString("id"),
      rs.getString("taskId"),
      rs.getString("url"),
      rs.getString("thumbnailUrl"),
      rs.getString("storageKey"),
      integer(rs, "width"),
      integer(rs, "height"),
      rs.getString("format"),
      integer(rs, "sizeBytes"),
      rs.getString("hash"),
      instant(rs, "createdAt")
    );
  }

  public RowMapper<RedemptionCode> redemptionCodeMapper() {
    return (rs, rowNum) -> new RedemptionCode(
      rs.getString("id"),
      rs.getString("code"),
      rs.getString("activityKey"),
      rs.getInt("credits"),
      rs.getInt("maxUses"),
      stringArray(rs, "usedBy"),
      instant(rs, "expiresAt"),
      rs.getBoolean("active"),
      instant(rs, "createdAt"),
      instant(rs, "updatedAt")
    );
  }

  public Instant instant(ResultSet rs, String column) throws SQLException {
    Timestamp value = rs.getTimestamp(column);
    return value == null ? null : value.toInstant();
  }

  public Integer integer(ResultSet rs, String column) throws SQLException {
    int value = rs.getInt(column);
    return rs.wasNull() ? null : value;
  }

  @SuppressWarnings("unchecked")
  private List<String> stringArray(ResultSet rs, String column) throws SQLException {
    Array array = rs.getArray(column);
    if (array == null) return List.of();
    Object raw = array.getArray();
    if (raw instanceof String[] strings) return List.of(strings);
    if (raw instanceof Object[] objects) {
      List<String> values = new ArrayList<>();
      for (Object item : objects) values.add(String.valueOf(item));
      return values;
    }
    return (List<String>) raw;
  }
}
