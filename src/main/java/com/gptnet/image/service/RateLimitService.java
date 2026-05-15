package com.gptnet.image.service;

import com.gptnet.image.support.AppException;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class RateLimitService {
  private final StringRedisTemplate redis;
  private final String keyPrefix;
  private final int ipGenerationRpm;
  private final int userGenerationRpm;
  private final int apiKeyGenerationRpm;
  private final int authIpRpm;
  private final int authIdentityRpm;
  private final int adminAuthIpRpm;
  private final int adminAuthIdentityRpm;
  private final boolean trustProxy;

  public RateLimitService(
    StringRedisTemplate redis,
    @Value("${REDIS_KEY_PREFIX:draw:}") String keyPrefix,
    @Value("${GENERATION_IP_RPM:60}") int ipGenerationRpm,
    @Value("${GENERATION_USER_RPM:30}") int userGenerationRpm,
    @Value("${GENERATION_API_KEY_RPM:120}") int apiKeyGenerationRpm,
    @Value("${AUTH_IP_RPM:20}") int authIpRpm,
    @Value("${AUTH_IDENTITY_RPM:6}") int authIdentityRpm,
    @Value("${ADMIN_AUTH_IP_RPM:10}") int adminAuthIpRpm,
    @Value("${ADMIN_AUTH_IDENTITY_RPM:3}") int adminAuthIdentityRpm,
    @Value("${TRUST_PROXY:false}") boolean trustProxy
  ) {
    this.redis = redis;
    this.keyPrefix = keyPrefix.endsWith(":") ? keyPrefix : keyPrefix + ":";
    this.ipGenerationRpm = Math.max(1, ipGenerationRpm);
    this.userGenerationRpm = Math.max(1, userGenerationRpm);
    this.apiKeyGenerationRpm = Math.max(1, apiKeyGenerationRpm);
    this.authIpRpm = Math.max(1, authIpRpm);
    this.authIdentityRpm = Math.max(1, authIdentityRpm);
    this.adminAuthIpRpm = Math.max(1, adminAuthIpRpm);
    this.adminAuthIdentityRpm = Math.max(1, adminAuthIdentityRpm);
    this.trustProxy = trustProxy;
  }

  public void checkSessionGeneration(HttpServletRequest request, String userId) {
    check("gen:ip:" + clientIp(request), ipGenerationRpm);
    check("gen:user:" + userId, userGenerationRpm);
  }

  public void checkApiGeneration(HttpServletRequest request, String apiKeyId) {
    check("gen:ip:" + clientIp(request), ipGenerationRpm);
    check("gen:api-key:" + apiKeyId, apiKeyGenerationRpm);
  }

  public void checkAuthAttempt(HttpServletRequest request, String identity, boolean adminIdentity) {
    String normalized = normalizeIdentity(identity);
    check("auth:ip:" + clientIp(request), adminIdentity ? adminAuthIpRpm : authIpRpm);
    check("auth:id:" + normalized, adminIdentity ? adminAuthIdentityRpm : authIdentityRpm);
  }

  public void checkRegisterAttempt(HttpServletRequest request) {
    check("auth:register:ip:" + clientIp(request), authIpRpm);
  }

  private void check(String subject, int limit) {
    String key = keyPrefix + "rate:" + subject + ":" + (System.currentTimeMillis() / 60000L);
    Long value = redis.opsForValue().increment(key);
    if (value != null && value == 1L) redis.expire(key, Duration.ofSeconds(90));
    if (value != null && value > limit) {
      throw AppException.tooManyRequests("RATE_LIMITED", "请求过于频繁，请稍后再试");
    }
  }

  private String normalizeIdentity(String identity) {
    String value = identity == null ? "" : identity.trim().toLowerCase();
    if (value.isBlank()) return "blank";
    return value.replaceAll("[^a-z0-9@._:-]", "_");
  }

  private String clientIp(HttpServletRequest request) {
    if (trustProxy) {
      String forwarded = request.getHeader("X-Forwarded-For");
      if (forwarded != null && !forwarded.isBlank()) return sanitizeIp(forwarded.split(",")[0]);
      String realIp = request.getHeader("X-Real-IP");
      if (realIp != null && !realIp.isBlank()) return sanitizeIp(realIp);
    }
    return request.getRemoteAddr() == null ? "unknown" : request.getRemoteAddr();
  }

  private String sanitizeIp(String value) {
    String text = value == null ? "" : value.trim();
    return text.isBlank() ? "unknown" : text.replaceAll("[^A-Za-z0-9:.\\[\\]-]", "_");
  }
}
