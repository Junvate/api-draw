package com.gptnet.image.service;

import com.gptnet.image.model.ImageTask;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
public class QueueService {
  private final StringRedisTemplate redis;
  private final Db db;
  private final AtomicBoolean started = new AtomicBoolean(false);
  private final String keyPrefix;
  private final int concurrency;
  private final int attempts;
  private final long backoffMs;
  private final boolean workerEnabled;
  private final long stalledTaskMs;
  private final long queueLimit;
  private ImageService imageService;
  private ExecutorService executor;

  public QueueService(
    StringRedisTemplate redis,
    Db db,
    @Value("${REDIS_KEY_PREFIX:draw:}") String keyPrefix,
    @Value("${IMAGE_WORKER_CONCURRENCY:10}") int concurrency,
    @Value("${IMAGE_JOB_ATTEMPTS:3}") int attempts,
    @Value("${IMAGE_JOB_BACKOFF_MS:5000}") long backoffMs,
    @Value("${IMAGE_WORKER_ENABLED:true}") boolean workerEnabled,
    @Value("${IMAGE_STALLED_TASK_MS:600000}") long stalledTaskMs,
    @Value("${GATEWAY_QUEUE_LIMIT:200}") long queueLimit
  ) {
    this.redis = redis;
    this.db = db;
    this.keyPrefix = keyPrefix.endsWith(":") ? keyPrefix : keyPrefix + ":";
    this.concurrency = Math.max(1, concurrency);
    this.attempts = Math.max(1, attempts);
    this.backoffMs = Math.max(0, backoffMs);
    this.workerEnabled = workerEnabled;
    this.stalledTaskMs = Math.max(60000, stalledTaskMs);
    this.queueLimit = Math.max(1, queueLimit);
  }

  public void setImageService(ImageService imageService) {
    this.imageService = imageService;
  }

  public void enqueue(String taskId) {
    enqueue(taskId, true);
  }

  private void enqueue(String taskId, boolean enforceLimit) {
    try {
      if (enforceLimit && len("image:waiting") + zsize("image:delayed") >= queueLimit) {
        throw new QueueOverloadedException("任务队列已满，请稍后再试");
      }
      redis.opsForSet().add(key("image:known"), taskId);
      redis.opsForList().leftPush(key("image:waiting"), taskId);
      redis.opsForHash().put(key("image:attempts"), taskId, "0");
    } catch (RedisConnectionFailureException exception) {
      throw exception;
    }
  }

  public static class QueueOverloadedException extends RuntimeException {
    public QueueOverloadedException(String message) {
      super(message);
    }
  }

  public void recoverPendingTasks() {
    int recovered = 0;
    List<ImageTask> tasks = db.pendingTasks();
    for (ImageTask task : tasks) {
      if ("processing".equals(task.status())) {
        db.jdbc().update("UPDATE \"ImageTask\" SET \"status\" = 'queued'::\"ImageTaskStatus\", \"updatedAt\" = now() WHERE \"id\" = :id",
          Map.of("id", task.id()));
      }
      enqueue(task.id(), false);
      recovered += 1;
    }
    if (recovered > 0) redis.opsForValue().increment(key("image:recovered"), recovered);
  }

  public void startWorker() {
    if (!workerEnabled || !started.compareAndSet(false, true)) return;
    executor = Executors.newFixedThreadPool(concurrency);
    for (int index = 0; index < concurrency; index += 1) {
      executor.submit(this::workerLoop);
    }
  }

  public QueueStats stats() {
    releaseDueDelayed();
    recoverStalledActive();
    long waiting = len("image:waiting");
    long active = size("image:active");
    long completed = value("image:completed");
    long failed = value("image:failed");
    long delayed = zsize("image:delayed");
    long dead = len("image:dead");
    long recovered = value("image:recovered");
    return new QueueStats(waiting, active, completed, failed, delayed, dead, recovered);
  }

  private void workerLoop() {
    while (!Thread.currentThread().isInterrupted()) {
      String taskId = null;
      boolean locked = false;
      try {
        releaseDueDelayed();
        recoverStalledActive();
        taskId = redis.opsForList().rightPop(key("image:waiting"), Duration.ofSeconds(2));
        if (taskId == null || taskId.isBlank()) continue;
        locked = Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(
          key("image:lock:" + taskId), String.valueOf(Instant.now().toEpochMilli()), Duration.ofMillis(stalledTaskMs)
        ));
        if (!locked) continue;
        redis.opsForSet().add(key("image:active"), taskId);
        redis.opsForHash().put(key("image:active:started"), taskId, String.valueOf(Instant.now().toEpochMilli()));
        ProcessResult result = processOnce(taskId);
        if (result == ProcessResult.SUCCESS) {
          redis.opsForHash().delete(key("image:attempts"), taskId);
          redis.opsForValue().increment(key("image:completed"));
        } else if (result == ProcessResult.RETRY) {
          scheduleRetry(taskId);
        } else if (result == ProcessResult.SKIPPED) {
          redis.opsForHash().delete(key("image:attempts"), taskId);
        } else {
          moveToDead(taskId);
          redis.opsForValue().increment(key("image:failed"));
        }
      } catch (Exception exception) {
        if (taskId != null) {
          moveToDead(taskId);
          redis.opsForValue().increment(key("image:failed"));
        }
      } finally {
        if (taskId != null && locked) redis.opsForSet().remove(key("image:active"), taskId);
        if (taskId != null && locked) redis.opsForHash().delete(key("image:active:started"), taskId);
        if (taskId != null && locked) redis.delete(key("image:lock:" + taskId));
      }
    }
  }

  private ProcessResult processOnce(String taskId) {
    ImageTask current = db.imageTaskById(taskId).orElse(null);
    if (current == null) return ProcessResult.FAILED;
    if (!"queued".equals(current.status())) return ProcessResult.SKIPPED;
    int attempt = attempt(taskId) + 1;
    redis.opsForHash().put(key("image:attempts"), taskId, String.valueOf(attempt));
    try {
      ImageTask task = imageService.processTask(taskId, attempt, attempts);
      if (task != null && "success".equals(task.status())) return ProcessResult.SUCCESS;
      if (task != null && "queued".equals(task.status()) && attempt < attempts) return ProcessResult.RETRY;
      return ProcessResult.FAILED;
    } catch (Exception exception) {
      UpstreamException upstreamException = upstreamException(exception);
      if (upstreamException != null && !upstreamException.retryable()) return ProcessResult.FAILED;
      return attempt < attempts ? ProcessResult.RETRY : ProcessResult.FAILED;
    }
  }

  private void scheduleRetry(String taskId) {
    int attempt = attempt(taskId);
    long runAt = Instant.now().toEpochMilli() + Math.max(1000, backoffMs * Math.max(1, attempt));
    redis.opsForZSet().add(key("image:delayed"), taskId, runAt);
  }

  private void releaseDueDelayed() {
    long now = Instant.now().toEpochMilli();
    var due = redis.opsForZSet().rangeByScore(key("image:delayed"), 0, now, 0, 100);
    if (due == null || due.isEmpty()) return;
    for (String taskId : due) {
      redis.opsForZSet().remove(key("image:delayed"), taskId);
      redis.opsForList().leftPush(key("image:waiting"), taskId);
    }
  }

  private void recoverStalledActive() {
    Map<Object, Object> active = redis.opsForHash().entries(key("image:active:started"));
    long cutoff = Instant.now().toEpochMilli() - stalledTaskMs;
    for (Map.Entry<Object, Object> entry : active.entrySet()) {
      String taskId = String.valueOf(entry.getKey());
      long startedAt = parseLong(String.valueOf(entry.getValue()));
      ImageTask task = db.imageTaskById(taskId).orElse(null);
      if (task == null || !"processing".equals(task.status())) {
        redis.opsForHash().delete(key("image:active:started"), taskId);
        redis.opsForSet().remove(key("image:active"), taskId);
        if (task != null && "queued".equals(task.status()) && !waitingContains(taskId)) {
          redis.opsForList().leftPush(key("image:waiting"), taskId);
          redis.opsForValue().increment(key("image:recovered"));
        }
        continue;
      }
      if (startedAt > 0 && startedAt < cutoff) {
        redis.opsForHash().delete(key("image:active:started"), taskId);
        redis.opsForSet().remove(key("image:active"), taskId);
        db.jdbc().update("UPDATE \"ImageTask\" SET \"status\" = 'queued'::\"ImageTaskStatus\", \"updatedAt\" = now() WHERE \"id\" = :id AND \"status\" = 'processing'::\"ImageTaskStatus\"",
          Map.of("id", taskId));
        redis.opsForList().leftPush(key("image:waiting"), taskId);
        redis.opsForValue().increment(key("image:recovered"));
      }
    }
  }

  private void moveToDead(String taskId) {
    redis.opsForHash().delete(key("image:attempts"), taskId);
    redis.opsForZSet().remove(key("image:delayed"), taskId);
    redis.opsForList().leftPush(key("image:dead"), taskId);
  }

  private int attempt(String taskId) {
    Object value = redis.opsForHash().get(key("image:attempts"), taskId);
    return Math.toIntExact(Math.min(Integer.MAX_VALUE, parseLong(value == null ? "" : String.valueOf(value))));
  }

  private UpstreamException upstreamException(Throwable throwable) {
    Throwable current = throwable;
    while (current != null) {
      if (current instanceof UpstreamException upstreamException) return upstreamException;
      current = current.getCause();
    }
    return null;
  }

  private long len(String name) {
    Long value = redis.opsForList().size(key(name));
    return value == null ? 0 : value;
  }

  private long size(String name) {
    Long value = redis.opsForSet().size(key(name));
    return value == null ? 0 : value;
  }

  private long zsize(String name) {
    Long value = redis.opsForZSet().size(key(name));
    return value == null ? 0 : value;
  }

  private long value(String name) {
    String value = redis.opsForValue().get(key(name));
    if (value == null || value.isBlank()) return 0;
    try {
      return parseLong(value);
    } catch (NumberFormatException ignored) {
      return 0;
    }
  }

  private boolean waitingContains(String taskId) {
    List<String> waiting = redis.opsForList().range(key("image:waiting"), 0, -1);
    return waiting != null && new HashSet<>(waiting).contains(taskId);
  }

  private long parseLong(String value) {
    if (value == null || value.isBlank()) return 0;
    try {
      return Long.parseLong(value);
    } catch (NumberFormatException ignored) {
      return 0;
    }
  }

  private String key(String suffix) {
    return keyPrefix + suffix;
  }

  private enum ProcessResult {
    SUCCESS,
    RETRY,
    FAILED,
    SKIPPED
  }

  public record QueueStats(long waiting, long active, long completed, long failed, long delayed, long dead, long recovered) {}
}
