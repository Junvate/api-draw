package com.gptnet.image.model;

import java.time.Instant;
import java.util.List;

public record ImageTask(
  String id,
  String userId,
  String apiKeyId,
  String gatewayId,
  String requestId,
  String model,
  String prompt,
  String negativePrompt,
  String size,
  String quality,
  String outputFormat,
  String background,
  int imageCount,
  String status,
  String errorCode,
  String errorMessage,
  int retryCount,
  int maxRetries,
  int costCredits,
  Integer latencyMs,
  Instant startedAt,
  Instant finishedAt,
  Instant createdAt,
  Instant updatedAt,
  List<ImageResult> results,
  User user,
  Gateway gateway
) {
  public ImageTask withResults(List<ImageResult> nextResults) {
    return new ImageTask(id, userId, apiKeyId, gatewayId, requestId, model, prompt, negativePrompt, size, quality,
      outputFormat, background, imageCount, status, errorCode, errorMessage, retryCount, maxRetries, costCredits,
      latencyMs, startedAt, finishedAt, createdAt, updatedAt, nextResults, user, gateway);
  }

  public ImageTask withUser(User nextUser) {
    return new ImageTask(id, userId, apiKeyId, gatewayId, requestId, model, prompt, negativePrompt, size, quality,
      outputFormat, background, imageCount, status, errorCode, errorMessage, retryCount, maxRetries, costCredits,
      latencyMs, startedAt, finishedAt, createdAt, updatedAt, results, nextUser, gateway);
  }

  public ImageTask withGateway(Gateway nextGateway) {
    return new ImageTask(id, userId, apiKeyId, gatewayId, requestId, model, prompt, negativePrompt, size, quality,
      outputFormat, background, imageCount, status, errorCode, errorMessage, retryCount, maxRetries, costCredits,
      latencyMs, startedAt, finishedAt, createdAt, updatedAt, results, user, nextGateway);
  }
}
