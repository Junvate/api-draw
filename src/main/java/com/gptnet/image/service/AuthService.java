package com.gptnet.image.service;

import com.gptnet.image.dto.AuthDtos.LoginRequest;
import com.gptnet.image.dto.AuthDtos.RegisterRequest;
import com.gptnet.image.model.ApiKey;
import com.gptnet.image.model.User;
import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
  private final Db db;
  private final SecurityService security;
  private final String nodeEnv;
  private final String seedAdminEmail;
  private final String seedAdminPassword;
  private final String seedAdminName;
  private final int seedAdminCredits;
  private final long touchIntervalMs;

  public AuthService(
    Db db,
    SecurityService security,
    @Value("${NODE_ENV:development}") String nodeEnv,
    @Value("${SEED_ADMIN_EMAIL:}") String seedAdminEmail,
    @Value("${SEED_ADMIN_PASSWORD:}") String seedAdminPassword,
    @Value("${SEED_ADMIN_NAME:平台管理员}") String seedAdminName,
    @Value("${SEED_ADMIN_CREDITS:1000}") int seedAdminCredits,
    @Value("${API_KEY_LAST_USED_WRITE_INTERVAL_MS:300000}") long touchIntervalMs
  ) {
    this.db = db;
    this.security = security;
    this.nodeEnv = nodeEnv;
    this.seedAdminEmail = seedAdminEmail;
    this.seedAdminPassword = seedAdminPassword;
    this.seedAdminName = seedAdminName;
    this.seedAdminCredits = seedAdminCredits;
    this.touchIntervalMs = touchIntervalMs;
  }

  @Transactional
  public void seedAdmin() {
    String email = cleanEmail(seedAdminEmail);
    if (email.isBlank() || seedAdminPassword == null || seedAdminPassword.isBlank()) return;
    if (db.userByEmail(email).isPresent()) return;
    String id = db.id();
    db.jdbc().update("""
      INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "status")
      VALUES (:id, :email, :name, :passwordHash, 'admin'::"UserRole", 'active'::"UserStatus")
      """, new MapSqlParameterSource()
      .addValue("id", id)
      .addValue("email", email)
      .addValue("name", seedAdminName == null || seedAdminName.isBlank() ? "平台管理员" : seedAdminName.trim())
      .addValue("passwordHash", security.hashPassword(seedAdminPassword)));
    if (seedAdminCredits > 0) {
      addWalletEntry(id, seedAdminCredits, "seed", "seed-admin", id);
    }
  }

  @Transactional
  public User register(RegisterRequest body, HttpServletResponse response) {
    String email = cleanEmail(body.getEmail());
    if (db.userByEmail(email).isPresent()) {
      throw AppException.conflict("EMAIL_EXISTS", "邮箱已注册");
    }
    String id = db.id();
    String name = body.getName() == null || body.getName().trim().isBlank() ? email.split("@")[0] : body.getName().trim();
    db.jdbc().update("""
      INSERT INTO "User" ("id", "email", "name", "passwordHash", "role", "status")
      VALUES (:id, :email, :name, :passwordHash, 'user'::"UserRole", 'active'::"UserStatus")
      """, new MapSqlParameterSource()
      .addValue("id", id)
      .addValue("email", email)
      .addValue("name", name)
      .addValue("passwordHash", security.hashPassword(body.getPassword())));
    addWalletEntry(id, 20, "signup_bonus", "signup", id);
    User user = db.userById(id).orElseThrow();
    setSessionCookie(response, user.id());
    return user;
  }

  public User login(LoginRequest body, HttpServletResponse response) {
    String email = cleanEmail(body.getEmail());
    User user = db.userByEmail(email)
      .filter(found -> security.verifyPassword(body.getPassword(), found.passwordHash()))
      .orElseThrow(() -> AppException.unauthorized("BAD_CREDENTIALS", "邮箱或密码错误"));
    if (!"active".equals(user.status())) {
      throw AppException.forbidden("ACCOUNT_DISABLED", "账号已停用，请联系管理员");
    }
    setSessionCookie(response, user.id());
    return user;
  }

  public boolean isAdminEmail(String email) {
    String normalized = cleanEmail(email);
    if (normalized.isBlank()) return false;
    return db.userByEmail(normalized)
      .map(user -> "admin".equals(user.role()))
      .orElse(false);
  }

  public void logout(HttpServletResponse response) {
    ResponseCookie cookie = ResponseCookie.from("session", "")
      .path("/")
      .httpOnly(true)
      .secure("production".equals(nodeEnv))
      .sameSite("Lax")
      .maxAge(Duration.ZERO)
      .build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  public User validateSession(HttpServletRequest request) {
    String cookie = sessionCookie(request);
    SecurityService.SessionPayload session = security.readSession(cookie);
    if (session == null) throw AppException.unauthorized("UNAUTHENTICATED", "请先登录");
    User user = db.userById(session.userId())
      .orElseThrow(() -> AppException.unauthorized("UNAUTHENTICATED", "账号不可用"));
    if (!"active".equals(user.status())) throw AppException.unauthorized("UNAUTHENTICATED", "账号不可用");
    return user;
  }

  public AuthContext validateApiKey(HttpServletRequest request, String requiredScope) {
    String authorization = Optional.ofNullable(request.getHeader("Authorization")).orElse("");
    String bearer = authorization.startsWith("Bearer ") ? authorization.substring(7).trim() : "";
    String token = Optional.ofNullable(request.getHeader("X-Api-Key")).orElse(bearer).trim();
    if (token.isBlank()) throw AppException.unauthorized("UNAUTHENTICATED", "缺少 API Key");
    ApiKey apiKey = db.apiKeyByHash(security.hashApiKey(token))
      .orElseThrow(() -> AppException.unauthorized("UNAUTHENTICATED", "API Key 不可用"));
    if (!"active".equals(apiKey.status())) throw AppException.unauthorized("UNAUTHENTICATED", "API Key 不可用");
    if (apiKey.expiresAt() != null && apiKey.expiresAt().isBefore(Instant.now())) {
      throw AppException.unauthorized("UNAUTHENTICATED", "API Key 已过期");
    }
    if (requiredScope != null && !apiKey.scopes().contains(requiredScope)) {
      throw AppException.forbidden("FORBIDDEN", "API Key 权限不足");
    }
    User user = db.userById(apiKey.userId()).orElseThrow(() -> AppException.unauthorized("UNAUTHENTICATED", "账号不可用"));
    if (!"active".equals(user.status())) throw AppException.unauthorized("UNAUTHENTICATED", "账号不可用");
    touchApiKey(apiKey);
    return new AuthContext(user, apiKey);
  }

  public Map<String, Object> publicUser(User user) {
    return Maps.of(
      "id", user.id(),
      "tenantId", user.tenantId(),
      "email", user.email(),
      "name", user.name(),
      "role", user.role(),
      "status", user.status(),
      "createdAt", user.createdAt(),
      "updatedAt", user.updatedAt(),
      "credits", db.walletBalance(user.id())
    );
  }

  public Map<String, Object> publicApiKey(ApiKey apiKey) {
    return Maps.of(
      "id", apiKey.id(),
      "userId", apiKey.userId(),
      "name", apiKey.name(),
      "prefix", apiKey.prefix(),
      "scopes", apiKey.scopes(),
      "status", apiKey.status(),
      "expiresAt", apiKey.expiresAt(),
      "lastUsedAt", apiKey.lastUsedAt(),
      "createdAt", apiKey.createdAt(),
      "updatedAt", apiKey.updatedAt()
    );
  }

  public void requireAdmin(User user) {
    if (user == null || !"admin".equals(user.role())) {
      throw AppException.forbidden("FORBIDDEN", "需要管理员权限");
    }
  }

  public void addWalletEntry(String userId, int amount, String reason, String refId, String actorId) {
    db.jdbc().update("""
      INSERT INTO "WalletEntry" ("id", "userId", "amount", "reason", "refId", "actorId")
      VALUES (:id, :userId, :amount, CAST(:reason AS "WalletEntryReason"), :refId, :actorId)
      """, new MapSqlParameterSource()
      .addValue("id", db.id())
      .addValue("userId", userId)
      .addValue("amount", amount)
      .addValue("reason", reason)
      .addValue("refId", refId)
      .addValue("actorId", actorId));
  }

  public void lockUserWallet(String userId) {
    db.jdbc().queryForObject("""
      SELECT "id" FROM "User" WHERE "id" = :id FOR UPDATE
      """, Map.of("id", userId), String.class);
  }

  private void setSessionCookie(HttpServletResponse response, String userId) {
    ResponseCookie cookie = ResponseCookie.from("session", security.createSession(userId))
      .path("/")
      .httpOnly(true)
      .secure("production".equals(nodeEnv))
      .sameSite("Lax")
      .maxAge(Duration.ofMillis(security.sessionTtlMs()))
      .build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  private void touchApiKey(ApiKey apiKey) {
    long last = apiKey.lastUsedAt() == null ? 0 : apiKey.lastUsedAt().toEpochMilli();
    if (touchIntervalMs == 0 || Instant.now().toEpochMilli() - last >= touchIntervalMs) {
      db.jdbc().update("""
        UPDATE "ApiKey" SET "lastUsedAt" = now(), "updatedAt" = now()
        WHERE "id" = :id
        """, Map.of("id", apiKey.id()));
    }
  }

  private String cleanEmail(String value) {
    return String.valueOf(value == null ? "" : value).trim().toLowerCase();
  }

  private String sessionCookie(HttpServletRequest request) {
    Cookie[] cookies = request.getCookies();
    if (cookies == null) return null;
    for (Cookie cookie : cookies) {
      if ("session".equals(cookie.getName())) return cookie.getValue();
    }
    return null;
  }

  public record AuthContext(User user, ApiKey apiKey) {}
}
