package com.gptnet.image.model;

import java.time.Instant;
import java.util.List;

public record RedemptionCode(
  String id,
  String code,
  String activityKey,
  int credits,
  int maxUses,
  List<String> usedBy,
  Instant expiresAt,
  boolean active,
  Instant createdAt,
  Instant updatedAt
) {}
