package com.gptnet.image.service;

import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import javax.imageio.ImageIO;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class CaptchaService {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final int WIDTH = 104;
  private static final int HEIGHT = 36;

  private final StringRedisTemplate redis;
  private final String keyPrefix;
  private final Duration ttl;

  public CaptchaService(
    StringRedisTemplate redis,
    @Value("${REDIS_KEY_PREFIX:draw:}") String keyPrefix,
    @Value("${REGISTER_CAPTCHA_TTL_SECONDS:300}") long ttlSeconds
  ) {
    this.redis = redis;
    this.keyPrefix = keyPrefix.endsWith(":") ? keyPrefix : keyPrefix + ":";
    this.ttl = Duration.ofSeconds(Math.max(60, ttlSeconds));
  }

  public Map<String, Object> create(HttpServletRequest request) {
    String id = UUID.randomUUID().toString().replace("-", "");
    String code = String.format("%04d", RANDOM.nextInt(10_000));
    redis.opsForValue().set(key(id), code, ttl);
    return Maps.of(
      "id", id,
      "image", "data:image/png;base64," + Base64.getEncoder().encodeToString(render(code))
    );
  }

  public void verify(String id, String code) {
    String normalizedId = id == null ? "" : id.trim();
    String normalizedCode = code == null ? "" : code.trim();
    if (!normalizedCode.matches("\\d{4}") || normalizedId.isBlank()) {
      throw AppException.badRequest("CAPTCHA_INVALID", "验证码错误");
    }
    String key = key(normalizedId);
    String expected = redis.opsForValue().get(key);
    redis.delete(key);
    if (expected == null || !expected.equals(normalizedCode)) {
      throw AppException.badRequest("CAPTCHA_INVALID", "验证码错误或已过期");
    }
  }

  private String key(String id) {
    return keyPrefix + "captcha:register:" + id;
  }

  private byte[] render(String code) {
    try {
      BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_RGB);
      Graphics2D g = image.createGraphics();
      g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
      g.setColor(new Color(247, 249, 251));
      g.fillRect(0, 0, WIDTH, HEIGHT);
      g.setStroke(new BasicStroke(1.2f));
      for (int i = 0; i < 6; i++) {
        g.setColor(new Color(190 + RANDOM.nextInt(40), 198 + RANDOM.nextInt(35), 208 + RANDOM.nextInt(35)));
        g.drawLine(RANDOM.nextInt(WIDTH), RANDOM.nextInt(HEIGHT), RANDOM.nextInt(WIDTH), RANDOM.nextInt(HEIGHT));
      }
      g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 24));
      for (int i = 0; i < code.length(); i++) {
        g.setColor(new Color(25 + RANDOM.nextInt(45), 45 + RANDOM.nextInt(65), 70 + RANDOM.nextInt(85)));
        AffineTransform transform = g.getTransform();
        g.rotate(Math.toRadians(-10 + RANDOM.nextInt(21)), 18 + i * 20, 22);
        g.drawString(String.valueOf(code.charAt(i)), 12 + i * 21, 26 + RANDOM.nextInt(4));
        g.setTransform(transform);
      }
      g.dispose();
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      ImageIO.write(image, "png", out);
      return out.toByteArray();
    } catch (Exception exception) {
      throw new IllegalStateException("Cannot create captcha", exception);
    }
  }
}
