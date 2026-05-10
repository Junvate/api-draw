package com.gptnet.image.service;

import com.gptnet.image.support.Ids;
import com.gptnet.image.support.Json;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class SecurityService {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final HexFormat HEX = HexFormat.of();
  private static final Base64.Encoder B64_URL = Base64.getUrlEncoder().withoutPadding();
  private static final Base64.Decoder B64_URL_DECODER = Base64.getUrlDecoder();

  private final String sessionSecret;
  private final long sessionTtlMs;

  public SecurityService(
    @Value("${SESSION_SECRET:dev-session-secret-change-me}") String sessionSecret,
    @Value("${SESSION_TTL_MS:604800000}") long sessionTtlMs
  ) {
    this.sessionSecret = sessionSecret;
    this.sessionTtlMs = sessionTtlMs;
  }

  public String hashPassword(String password) {
    String salt = HEX.formatHex(randomBytes(16));
    byte[] hash = scrypt(password, salt);
    return salt + ":" + HEX.formatHex(hash);
  }

  public boolean verifyPassword(String password, String stored) {
    if (stored == null || !stored.contains(":")) return false;
    String[] parts = stored.split(":", 2);
    byte[] expected;
    try {
      expected = HEX.parseHex(parts[1]);
    } catch (IllegalArgumentException ignored) {
      return false;
    }
    byte[] candidate = scrypt(password, parts[0]);
    return MessageDigest.isEqual(expected, candidate);
  }

  public ApiKeyToken createApiKey() {
    String token = "draw_" + B64_URL.encodeToString(randomBytes(32));
    return new ApiKeyToken(token, token.substring(0, Math.min(14, token.length())), hashApiKey(token));
  }

  public String hashApiKey(String token) {
    return sha256Hex(String.valueOf(token).getBytes(StandardCharsets.UTF_8));
  }

  public String createSession(String userId) {
    try {
      Map<String, Object> payload = Map.of(
        "userId", userId,
        "sid", HEX.formatHex(randomBytes(16)),
        "expiresAt", Instant.now().toEpochMilli() + sessionTtlMs,
        "nonce", HEX.formatHex(randomBytes(16))
      );
      String encoded = B64_URL.encodeToString(Json.MAPPER.writeValueAsBytes(payload));
      return encoded + "." + sign(encoded);
    } catch (Exception exception) {
      throw new IllegalStateException("Cannot create session", exception);
    }
  }

  public SessionPayload readSession(String cookieValue) {
    if (cookieValue == null || cookieValue.isBlank()) return null;
    String[] parts = cookieValue.split("\\.", 2);
    if (parts.length != 2) return null;
    if (!safeEqual(parts[1], sign(parts[0]))) return null;
    try {
      Map<String, Object> payload = Json.MAPPER.readValue(B64_URL_DECODER.decode(parts[0]), Json.MAP);
      String userId = String.valueOf(payload.getOrDefault("userId", ""));
      String sid = String.valueOf(payload.getOrDefault("sid", ""));
      long expiresAt = ((Number) payload.getOrDefault("expiresAt", 0)).longValue();
      String nonce = String.valueOf(payload.getOrDefault("nonce", ""));
      if (userId.isBlank() || sid.isBlank() || expiresAt < Instant.now().toEpochMilli()) return null;
      return new SessionPayload(userId, sid, expiresAt, nonce);
    } catch (Exception ignored) {
      return null;
    }
  }

  public String encryptSecret(String value) {
    try {
      byte[] iv = randomBytes(12);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(secretKey(), "AES"), new GCMParameterSpec(128, iv));
      byte[] output = cipher.doFinal(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
      byte[] encrypted = Arrays.copyOf(output, output.length - 16);
      byte[] tag = Arrays.copyOfRange(output, output.length - 16, output.length);
      return B64_URL.encodeToString(iv) + "." + B64_URL.encodeToString(tag) + "." + B64_URL.encodeToString(encrypted);
    } catch (Exception exception) {
      throw new IllegalStateException("Cannot encrypt secret", exception);
    }
  }

  public String decryptSecret(String payload) {
    if (payload == null || payload.isBlank()) return null;
    String[] parts = payload.split("\\.", 3);
    if (parts.length != 3) return null;
    try {
      byte[] iv = B64_URL_DECODER.decode(parts[0]);
      byte[] tag = B64_URL_DECODER.decode(parts[1]);
      byte[] encrypted = B64_URL_DECODER.decode(parts[2]);
      byte[] combined = ByteBuffer.allocate(encrypted.length + tag.length).put(encrypted).put(tag).array();
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(secretKey(), "AES"), new GCMParameterSpec(128, iv));
      return new String(cipher.doFinal(combined), StandardCharsets.UTF_8);
    } catch (Exception ignored) {
      return null;
    }
  }

  public String maskSecret(String value) {
    return maskSecret(value, 4);
  }

  public String maskSecret(String value, int keep) {
    String text = value == null ? "" : value;
    if (text.isEmpty()) return "";
    if (text.length() <= keep * 2) return text.substring(0, Math.min(keep, text.length())) + "****";
    return text.substring(0, keep) + "****" + text.substring(text.length() - keep);
  }

  public long sessionTtlMs() {
    return sessionTtlMs;
  }

  private byte[] scrypt(String password, String salt) {
    return SCrypt.generate(
      String.valueOf(password).getBytes(StandardCharsets.UTF_8),
      salt.getBytes(StandardCharsets.UTF_8),
      16384,
      8,
      1,
      64
    );
  }

  private String sign(String value) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(sessionSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return HEX.formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception exception) {
      throw new IllegalStateException("Cannot sign session", exception);
    }
  }

  private byte[] secretKey() {
    return sha256(sessionSecret.getBytes(StandardCharsets.UTF_8));
  }

  private String sha256Hex(byte[] value) {
    return HEX.formatHex(sha256(value));
  }

  private byte[] sha256(byte[] value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value);
    } catch (Exception exception) {
      throw new IllegalStateException(exception);
    }
  }

  private boolean safeEqual(String a, String b) {
    return MessageDigest.isEqual(String.valueOf(a).getBytes(StandardCharsets.UTF_8), String.valueOf(b).getBytes(StandardCharsets.UTF_8));
  }

  private byte[] randomBytes(int length) {
    byte[] bytes = new byte[length];
    RANDOM.nextBytes(bytes);
    return bytes;
  }

  public record SessionPayload(String userId, String sid, long expiresAt, String nonce) {}
  public record ApiKeyToken(String token, String prefix, String keyHash) {}
}
