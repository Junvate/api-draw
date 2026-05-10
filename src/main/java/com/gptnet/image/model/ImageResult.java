package com.gptnet.image.model;

import java.time.Instant;

public record ImageResult(
  String id,
  String taskId,
  String url,
  String thumbnailUrl,
  String storageKey,
  Integer width,
  Integer height,
  String format,
  Integer sizeBytes,
  String hash,
  Instant createdAt
) {}
