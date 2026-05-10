package com.gptnet.image.service;

public class UpstreamException extends RuntimeException {
  private final String code;
  private final int status;
  private final boolean retryable;
  private String requestUrl;
  private String rawResponse;

  public UpstreamException(String code, String message, int status, boolean retryable) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  public String code() { return code; }
  public int status() { return status; }
  public boolean retryable() { return retryable; }
  public String requestUrl() { return requestUrl; }
  public String rawResponse() { return rawResponse; }

  public UpstreamException withDebug(String requestUrl, String rawResponse) {
    this.requestUrl = requestUrl;
    this.rawResponse = rawResponse;
    return this;
  }

  public static UpstreamException fromHttp(int status, String message) {
    String text = message == null ? "" : message;
    String lower = text.toLowerCase();
    if (status == 401 || status == 403 || lower.contains("invalid token") || lower.contains("incorrect api key")) {
      return new UpstreamException("UPSTREAM_AUTH_FAILED", text, status, false);
    }
    if (status == 408 || lower.contains("timeout") || lower.contains("timed out")) {
      return new UpstreamException("UPSTREAM_TIMEOUT", text, status, true);
    }
    if (status == 429 || lower.contains("rate limit") || lower.contains("too many requests")) {
      return new UpstreamException("UPSTREAM_RATE_LIMIT", text, status, true);
    }
    if (status >= 500) {
      return new UpstreamException("UPSTREAM_UNAVAILABLE", text, status, true);
    }
    return new UpstreamException("UPSTREAM_REJECTED", text, status, false);
  }

  public static UpstreamException network(String message) {
    String text = message == null || message.isBlank() ? "上游网络请求失败" : message;
    boolean timeout = text.toLowerCase().contains("timeout") || text.toLowerCase().contains("timed out");
    return new UpstreamException(timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR", text, 0, true);
  }
}
