package com.gptnet.image.model;

import java.time.Instant;
import java.util.List;

public record ApiKey(
  String id,
  String userId,
  String name,
  String prefix,
  String keyHash,
  List<String> scopes,
  String status,
  Instant expiresAt,
  Instant lastUsedAt,
  Instant createdAt,
  Instant updatedAt
) {}
