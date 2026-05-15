package com.gptnet.image.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

public final class AdminDtos {
  private AdminDtos() {}

  public static class AdminCreateUserRequest {
    @Email
    @Size(max = 254)
    private String email;
    @Size(min = 8, max = 256)
    private String password;
    @Size(max = 80)
    private String name;
    private String status;
    @Min(0)
    @Max(1000000)
    private Integer credits;

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Integer getCredits() { return credits; }
    public void setCredits(Integer credits) { this.credits = credits; }
  }

  public static class PatchUserRequest {
    private String status;

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
  }

  public static class CreditsRequest {
    private String userId;
    @Min(-1000000)
    @Max(1000000)
    private Integer amount;
    @Size(max = 120)
    private String reason;

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public Integer getAmount() { return amount; }
    public void setAmount(Integer amount) { this.amount = amount; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
  }

  public static class CallSquareTestRequest {
    @Size(max = 500)
    private String url;
    @Size(max = 500)
    private String baseUrl;
    @Size(max = 2048)
    private String apiKey;
    @Size(max = 120)
    private String model;
    @Size(max = 8000)
    private String prompt;
    @Size(max = 120)
    private String upstreamGroup;
    @Size(max = 40)
    private String size;
    @Size(max = 40)
    private String outputFormat;
    @Size(max = 40)
    private String quality;
    @Size(max = 40)
    private String background;
    @Size(max = 100000)
    private String requestBody;
    @Min(1000)
    @Max(600000)
    private Integer timeoutMs;

    public String getUrl() { return url; }
    public void setUrl(String url) { this.url = url; }
    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getPrompt() { return prompt; }
    public void setPrompt(String prompt) { this.prompt = prompt; }
    public String getUpstreamGroup() { return upstreamGroup; }
    public void setUpstreamGroup(String upstreamGroup) { this.upstreamGroup = upstreamGroup; }
    public String getSize() { return size; }
    public void setSize(String size) { this.size = size; }
    public String getOutputFormat() { return outputFormat; }
    public void setOutputFormat(String outputFormat) { this.outputFormat = outputFormat; }
    public String getQuality() { return quality; }
    public void setQuality(String quality) { this.quality = quality; }
    public String getBackground() { return background; }
    public void setBackground(String background) { this.background = background; }
    public String getRequestBody() { return requestBody; }
    public void setRequestBody(String requestBody) { this.requestBody = requestBody; }
    public Integer getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(Integer timeoutMs) { this.timeoutMs = timeoutMs; }
  }

  public static class GatewayRequest {
    @Size(max = 120)
    private String name;
    private String provider;
    @Size(max = 500)
    private String baseUrl;
    @Size(max = 200)
    private String healthCheckPath;
    @Size(max = 200)
    private String generationPath;
    @Size(max = 120)
    private String upstreamGroup;
    @Size(max = 2048)
    private String apiKey;
    @Size(max = 120)
    private String model;
    @Min(0)
    @Max(100000)
    private Integer costCredits;
    @Min(1000)
    @Max(600000)
    private Integer timeoutMs;
    private Boolean enabled;
    @Min(-100000)
    @Max(100000)
    private Integer priority;
    private String healthStatus;
    @Min(0)
    private Integer consecutiveFailures;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getHealthCheckPath() { return healthCheckPath; }
    public void setHealthCheckPath(String healthCheckPath) { this.healthCheckPath = healthCheckPath; }
    public String getGenerationPath() { return generationPath; }
    public void setGenerationPath(String generationPath) { this.generationPath = generationPath; }
    public String getUpstreamGroup() { return upstreamGroup; }
    public void setUpstreamGroup(String upstreamGroup) { this.upstreamGroup = upstreamGroup; }
    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public Integer getCostCredits() { return costCredits; }
    public void setCostCredits(Integer costCredits) { this.costCredits = costCredits; }
    public Integer getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(Integer timeoutMs) { this.timeoutMs = timeoutMs; }
    public Boolean getEnabled() { return enabled; }
    public void setEnabled(Boolean enabled) { this.enabled = enabled; }
    public Integer getPriority() { return priority; }
    public void setPriority(Integer priority) { this.priority = priority; }
    public String getHealthStatus() { return healthStatus; }
    public void setHealthStatus(String healthStatus) { this.healthStatus = healthStatus; }
    public Integer getConsecutiveFailures() { return consecutiveFailures; }
    public void setConsecutiveFailures(Integer consecutiveFailures) { this.consecutiveFailures = consecutiveFailures; }
  }

  public static class RedemptionCodeRequest {
    @Size(max = 80)
    private String code;
    @Size(max = 80)
    private String activityKey;
    @Min(1)
    @Max(1000000)
    private Integer credits;
    @Min(1)
    @Max(1000000)
    private Integer maxUses;
    @Min(1)
    @Max(500)
    private Integer batchCount;
    private String expiresAt;
    private Boolean active;

    public String getCode() { return code; }
    public void setCode(String code) { this.code = code; }
    public String getActivityKey() { return activityKey; }
    public void setActivityKey(String activityKey) { this.activityKey = activityKey; }
    public Integer getCredits() { return credits; }
    public void setCredits(Integer credits) { this.credits = credits; }
    public Integer getMaxUses() { return maxUses; }
    public void setMaxUses(Integer maxUses) { this.maxUses = maxUses; }
    public Integer getBatchCount() { return batchCount; }
    public void setBatchCount(Integer batchCount) { this.batchCount = batchCount; }
    public String getExpiresAt() { return expiresAt; }
    public void setExpiresAt(String expiresAt) { this.expiresAt = expiresAt; }
    public Boolean getActive() { return active; }
    public void setActive(Boolean active) { this.active = active; }
  }

  public static class SensitiveWordRulesRequest {
    @Size(max = 1_000_000)
    private String patterns;
    private Boolean replace;

    public String getPatterns() { return patterns; }
    public void setPatterns(String patterns) { this.patterns = patterns; }
    public Boolean getReplace() { return replace; }
    public void setReplace(Boolean replace) { this.replace = replace; }
  }

  public static class SensitiveWordRulePatchRequest {
    @Size(max = 120)
    private String name;
    @Size(max = 1000)
    private String pattern;
    private Boolean enabled;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getPattern() { return pattern; }
    public void setPattern(String pattern) { this.pattern = pattern; }
    public Boolean getEnabled() { return enabled; }
    public void setEnabled(Boolean enabled) { this.enabled = enabled; }
  }
}
