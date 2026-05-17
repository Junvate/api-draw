package com.gptnet.image.controller;

import com.gptnet.image.dto.AdminDtos.AdminCreateUserRequest;
import com.gptnet.image.dto.AdminDtos.CallSquareTestRequest;
import com.gptnet.image.dto.AdminDtos.CreditsRequest;
import com.gptnet.image.dto.AdminDtos.GatewayRequest;
import com.gptnet.image.dto.AdminDtos.PatchUserRequest;
import com.gptnet.image.dto.AdminDtos.RedemptionCodeRequest;
import com.gptnet.image.dto.AdminDtos.SensitiveWordRulePatchRequest;
import com.gptnet.image.dto.AdminDtos.SensitiveWordRulesRequest;
import com.gptnet.image.dto.AdminDtos.UserWarningRequest;
import com.gptnet.image.model.User;
import com.gptnet.image.service.AdminService;
import com.gptnet.image.service.AuthService;
import com.gptnet.image.service.SensitiveWordService;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.MediaType;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
  private final AuthService auth;
  private final AdminService admin;
  private final SensitiveWordService sensitiveWords;

  public AdminController(AuthService auth, AdminService admin, SensitiveWordService sensitiveWords) {
    this.auth = auth;
    this.admin = admin;
    this.sensitiveWords = sensitiveWords;
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

  @DeleteMapping("/users/{id}")
  public Map<String, Object> deleteUser(HttpServletRequest request, @PathVariable String id) {
    User actor = requireAdmin(request);
    return admin.deleteUser(actor, request, id);
  }

  @PostMapping("/credits")
  public Map<String, Object> credits(HttpServletRequest request, @Valid @RequestBody CreditsRequest body) {
    User actor = requireAdmin(request);
    return admin.credits(actor, request, body);
  }

  @PostMapping("/user-warnings")
  public Map<String, Object> warnUser(HttpServletRequest request, @Valid @RequestBody UserWarningRequest body) {
    User actor = requireAdmin(request);
    return admin.warnUser(actor, request, body);
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

  @PostMapping(value = "/call-square/test", consumes = MediaType.APPLICATION_JSON_VALUE)
  public Map<String, Object> callSquareTest(HttpServletRequest request, @Valid @RequestBody CallSquareTestRequest body) {
    User actor = requireAdmin(request);
    return admin.callSquareTest(actor, request, body, List.of());
  }

  @PostMapping(value = "/call-square/test", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Map<String, Object> callSquareTestMultipart(
    HttpServletRequest request,
    @RequestParam(required = false) String url,
    @RequestParam(required = false) String baseUrl,
    @RequestParam(required = false) String apiKey,
    @RequestParam(required = false) String model,
    @RequestParam(required = false) String prompt,
    @RequestParam(required = false) String upstreamGroup,
    @RequestParam(required = false) String size,
    @RequestParam(required = false) String outputFormat,
    @RequestParam(required = false) String quality,
    @RequestParam(required = false) String background,
    @RequestParam(required = false) String requestBody,
    @RequestParam(required = false) Integer timeoutMs,
    @RequestPart(value = "image", required = false) List<MultipartFile> files,
    @RequestPart(value = "image[]", required = false) List<MultipartFile> imageArrayFiles
  ) {
    User actor = requireAdmin(request);
    CallSquareTestRequest body = new CallSquareTestRequest();
    body.setUrl(url);
    body.setBaseUrl(baseUrl);
    body.setApiKey(apiKey);
    body.setModel(model);
    body.setPrompt(prompt);
    body.setUpstreamGroup(upstreamGroup);
    body.setSize(size);
    body.setOutputFormat(outputFormat);
    body.setQuality(quality);
    body.setBackground(background);
    body.setRequestBody(requestBody);
    body.setTimeoutMs(timeoutMs);
    return admin.callSquareTest(actor, request, body, mergeFiles(files, imageArrayFiles));
  }

  @GetMapping("/call-square/config")
  public Map<String, Object> getCallSquareConfig(HttpServletRequest request) {
    requireAdmin(request);
    return admin.getCallSquareConfig();
  }

  @PatchMapping("/call-square/config")
  public Map<String, Object> saveCallSquareConfig(HttpServletRequest request, @Valid @RequestBody CallSquareTestRequest body) {
    User actor = requireAdmin(request);
    return admin.saveCallSquareConfig(actor, request, body);
  }

  @GetMapping("/jobs")
  public Map<String, Object> jobs(HttpServletRequest request, @RequestParam(value = "limit", defaultValue = "100") int limit) {
    requireAdmin(request);
    return admin.jobs(limit);
  }

  @GetMapping("/gallery")
  public Map<String, Object> gallery(
    HttpServletRequest request,
    @RequestParam(value = "limit", defaultValue = "500") int limit,
    @RequestParam(value = "offset", defaultValue = "0") int offset
  ) {
    requireAdmin(request);
    return admin.gallery(limit, offset);
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

  @DeleteMapping("/redemption-codes/{id}")
  public Map<String, Object> deleteCode(HttpServletRequest request, @PathVariable String id) {
    User actor = requireAdmin(request);
    return admin.deleteCode(actor, request, id);
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

  @GetMapping("/sensitive-words")
  public Map<String, Object> sensitiveWordRules(HttpServletRequest request) {
    requireAdmin(request);
    return sensitiveWords.rules();
  }

  @PostMapping("/sensitive-words")
  public Map<String, Object> configureSensitiveWordRules(HttpServletRequest request, @Valid @RequestBody SensitiveWordRulesRequest body) {
    User actor = requireAdmin(request);
    Map<String, Object> result = sensitiveWords.batchConfigure(actor.id(), body.getPatterns(), Boolean.TRUE.equals(body.getReplace()));
    admin.audit(actor, request, "risk.sensitive_words.configure", "sensitive_words",
      Maps.of("imported", result.get("imported"), "replace", result.get("replace")));
    return result;
  }

  @PatchMapping("/sensitive-words/{id}")
  public Map<String, Object> patchSensitiveWordRule(HttpServletRequest request, @PathVariable String id, @Valid @RequestBody SensitiveWordRulePatchRequest body) {
    User actor = requireAdmin(request);
    Map<String, Object> result = sensitiveWords.patchRule(id, body.getName(), body.getPattern(), body.getEnabled());
    admin.audit(actor, request, "risk.sensitive_word.update", id,
      Maps.of("name", body.getName(), "pattern", body.getPattern(), "enabled", body.getEnabled()));
    return result;
  }

  @DeleteMapping("/sensitive-words/{id}")
  public Map<String, Object> deleteSensitiveWordRule(HttpServletRequest request, @PathVariable String id) {
    User actor = requireAdmin(request);
    Map<String, Object> result = sensitiveWords.deleteRule(id);
    admin.audit(actor, request, "risk.sensitive_word.delete", id, Map.of());
    return result;
  }

  @GetMapping("/risk-alerts")
  public Map<String, Object> riskAlerts(HttpServletRequest request, @RequestParam(value = "limit", defaultValue = "100") int limit) {
    requireAdmin(request);
    return sensitiveWords.alerts(limit);
  }

  private User requireAdmin(HttpServletRequest request) {
    User user = auth.validateSession(request);
    auth.requireAdmin(user);
    return user;
  }

  private List<MultipartFile> mergeFiles(List<MultipartFile> first, List<MultipartFile> second) {
    return java.util.stream.Stream.concat(
      first == null ? java.util.stream.Stream.empty() : first.stream(),
      second == null ? java.util.stream.Stream.empty() : second.stream()
    ).toList();
  }
}
