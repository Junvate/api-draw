package com.gptnet.image.controller;

import com.gptnet.image.dto.AuthDtos.LoginRequest;
import com.gptnet.image.dto.AuthDtos.RegisterRequest;
import com.gptnet.image.model.User;
import com.gptnet.image.service.AuthService;
import com.gptnet.image.service.RateLimitService;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class AuthController {
  private final AuthService auth;
  private final RateLimitService rateLimit;

  public AuthController(AuthService auth, RateLimitService rateLimit) {
    this.auth = auth;
    this.rateLimit = rateLimit;
  }

  @PostMapping("/auth/register")
  public Map<String, Object> register(HttpServletRequest request, @Valid @RequestBody RegisterRequest body, HttpServletResponse response) {
    rateLimit.checkRegisterAttempt(request);
    User user = auth.register(body, response);
    return Maps.of("user", auth.publicUser(user));
  }

  @PostMapping("/auth/login")
  public Map<String, Object> login(HttpServletRequest request, @Valid @RequestBody LoginRequest body, HttpServletResponse response) {
    rateLimit.checkAuthAttempt(request, body.getEmail(), auth.isAdminEmail(body.getEmail()));
    User user = auth.login(body, response);
    return Maps.of("user", auth.publicUser(user));
  }

  @PostMapping("/auth/logout")
  public Map<String, Object> logout(HttpServletResponse response) {
    auth.logout(response);
    return Maps.of("ok", true);
  }

  @GetMapping("/me")
  public Map<String, Object> me(HttpServletRequest request) {
    try {
      User user = auth.validateSession(request);
      return Maps.of("user", auth.publicUser(user));
    } catch (Exception ignored) {
      return Maps.of("user", null);
    }
  }
}
