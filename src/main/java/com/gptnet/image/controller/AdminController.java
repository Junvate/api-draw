package com.gptnet.image.controller;

import com.gptnet.image.dto.AdminDtos.AdminCreateUserRequest;
import com.gptnet.image.dto.AdminDtos.CreditsRequest;
import com.gptnet.image.dto.AdminDtos.GatewayRequest;
import com.gptnet.image.dto.AdminDtos.PatchUserRequest;
import com.gptnet.image.dto.AdminDtos.RedemptionCodeRequest;
import com.gptnet.image.model.User;
import com.gptnet.image.service.AdminService;
import com.gptnet.image.service.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
  private final AuthService auth;
  private final AdminService admin;

  public AdminController(AuthService auth, AdminService admin) {
    this.auth = auth;
    this.admin = admin;
  }

  @GetMapping("/summary")
  public Map<String, Object> summary(HttpServletRequest request) {
    requireAdmin(request);
    return admin.summary();
  }

  @GetMapping("/usage")
  public Map<String, Object> usage(HttpServletRequest request, @RequestParam(value = "days", defaultValue = "14") int days) {
    requireAdmin(request);
    return admin.usage(days);
  }

  @GetMapping("/users")
  public Map<String, Object> users(HttpServletRequest request) {
    requireAdmin(request);
    return admin.users();
  }

  @PostMapping("/users")
  public Map<String, Object> createUser(HttpServletRequest request, @Valid @RequestBody AdminCreateUserRequest body) {
    User actor = requireAdmin(request);
    return admin.createUser(actor, request, body);
  }

  @PatchMapping("/users/{id}")
  public Map<String, Object> patchUser(HttpServletRequest request, @PathVariable String id, @Valid @RequestBody PatchUserRequest body) {
    User actor = requireAdmin(request);
    return admin.patchUser(actor, request, id, body);
  }

  @PostMapping("/credits")
  public Map<String, Object> credits(HttpServletRequest request, @Valid @RequestBody CreditsRequest body) {
    User actor = requireAdmin(request);
    return admin.credits(actor, request, body);
  }

  @GetMapping("/gateways")
  public Map<String, Object> gateways(HttpServletRequest request) {
    requireAdmin(request);
    return admin.gateways();
  }

  @PostMapping("/gateways")
  public Map<String, Object> createGateway(HttpServletRequest request, @Valid @RequestBody GatewayRequest body) {
    User actor = requireAdmin(request);
    return admin.createGateway(actor, request, body);
  }

  @PatchMapping("/gateways/{id}")
  public Map<String, Object> patchGateway(HttpServletRequest request, @PathVariable String id, @Valid @RequestBody GatewayRequest body) {
    User actor = requireAdmin(request);
    return admin.patchGateway(actor, request, id, body);
  }

  @DeleteMapping("/gateways/{id}")
  public Map<String, Object> deleteGateway(HttpServletRequest request, @PathVariable String id) {
    User actor = requireAdmin(request);
    return admin.deleteGateway(actor, request, id);
  }

  @PostMapping("/gateways/{id}/health-check")
  public Map<String, Object> health(HttpServletRequest request, @PathVariable String id) {
    User actor = requireAdmin(request);
    return admin.health(actor, request, id);
  }

  @PostMapping("/gateways/health-check")
  public Map<String, Object> healthAll(HttpServletRequest request) {
    User actor = requireAdmin(request);
    return admin.healthAll(actor, request);
  }

  @GetMapping("/jobs")
  public Map<String, Object> jobs(HttpServletRequest request, @RequestParam(value = "limit", defaultValue = "100") int limit) {
    requireAdmin(request);
    return admin.jobs(limit);
  }

  @GetMapping("/audit-logs")
  public Map<String, Object> auditLogs(HttpServletRequest request, @RequestParam(value = "limit", defaultValue = "100") int limit) {
    requireAdmin(request);
    return admin.auditLogs(limit);
  }

  @GetMapping("/redemption-codes")
  public Map<String, Object> codes(HttpServletRequest request) {
    requireAdmin(request);
    return admin.codes();
  }

  @PostMapping("/redemption-codes")
  public Map<String, Object> createCode(HttpServletRequest request, @Valid @RequestBody RedemptionCodeRequest body) {
    User actor = requireAdmin(request);
    return admin.createCode(actor, request, body);
  }

  @PatchMapping("/redemption-codes/{id}")
  public Map<String, Object> patchCode(HttpServletRequest request, @PathVariable String id, @Valid @RequestBody RedemptionCodeRequest body) {
    User actor = requireAdmin(request);
    return admin.patchCode(actor, request, id, body);
  }

  @GetMapping("/settings")
  public Map<String, Object> getSettings(HttpServletRequest request) {
    requireAdmin(request);
    return admin.getSettings();
  }

  @PatchMapping("/settings")
  public Map<String, Object> patchSettings(HttpServletRequest request, @RequestBody Map<String, String> body) {
    requireAdmin(request);
    return admin.patchSettings(body);
  }

  private User requireAdmin(HttpServletRequest request) {
    User user = auth.validateSession(request);
    auth.requireAdmin(user);
    return user;
  }
}
