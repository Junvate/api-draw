package com.gptnet.image.model;

import java.time.Instant;

public record User(
  String id,
  String tenantId,
  String email,
  String name,
  String passwordHash,
  String role,
  String status,
  Instant createdAt,
  Instant updatedAt
) {}
