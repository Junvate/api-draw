package com.gptnet.image.model;

import java.time.Instant;
import java.util.List;

public record Gateway(
  String id,
  String name,
  String provider,
  String baseUrl,
  String apiKeyEnv,
  String apiKeyCiphertext,
  String healthCheckPath,
  String generationPath,
  String upstreamGroup,
  List<String> exclusiveUserIds,
  String model,
  int costCredits,
  int timeoutMs,
  boolean enabled,
  int priority,
  String healthStatus,
  int consecutiveFailures,
  Instant disabledUntil,
  Instant lastCheckedAt,
  Instant lastSuccessAt,
  Instant lastFailureAt,
  Integer lastLatencyMs,
  String lastError,
  Instant createdAt,
  Instant updatedAt
) {}
