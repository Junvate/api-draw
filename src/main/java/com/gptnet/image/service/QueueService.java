package com.gptnet.image.service;

import com.gptnet.image.model.ImageTask;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

@Service
public class QueueService {
  private static final DefaultRedisScript<Long> ENQUEUE_SCRIPT = new DefaultRedisScript<>("""
    if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
      return 0
    end
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('SADD', KEYS[2], ARGV[1])
    redis.call('LPUSH', KEYS[3], ARGV[1])
    redis.call('HSETNX', KEYS[4], ARGV[1], '0')
    return 1
    """, Long.class);

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
  private final AtomicLong lastMaintenanceAt = new AtomicLong(0);
  private ImageService imageService;
  private ExecutorService executor;

  public QueueService(
    StringRedisTemplate redis,
    Db db,
    @Value("${REDIS_KEY_PREFIX:draw:}") String keyPrefix,
    @Value("${IMAGE_WORKER_CONCURRENCY:${GATEWAY_CONCURRENCY:200}}") int concurrency,
    @Value("${IMAGE_JOB_ATTEMPTS:3}") int attempts,
    @Value("${IMAGE_JOB_BACKOFF_MS:5000}") long backoffMs,
    @Value("${IMAGE_WORKER_ENABLED:true}") boolean workerEnabled,
    @Value("${IMAGE_STALLED_TASK_MS:600000}") long stalledTaskMs,
    @Value("${GATEWAY_QUEUE_LIMIT:5000}") long queueLimit
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

  public void enqueueExisting(String taskId) {
    enqueue(taskId, false);
  }

  private void enqueue(String taskId, boolean enforceLimit) {
    if (taskId == null || taskId.isBlank()) return;
    try {
      if (enforceLimit && db.pendingTaskCount() > queueLimit) {
        throw new QueueOverloadedException("任务队列已满，请稍后再试");
      }
      Long result = redis.execute(ENQUEUE_SCRIPT, List.of(
        key("image:queued"),
        key("image:waiting:set"),
        key("image:waiting"),
        key("image:attempts")
      ), taskId);
      if (result != null && result == -1L) {
        throw new QueueOverloadedException("任务队列已满，请稍后再试");
      }
      if (result != null && result == 0L && !hasPendingQueueState(taskId)) {
        forceWaiting(taskId);
      }
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
        int updated = db.jdbc().update("UPDATE \"ImageTask\" SET \"status\" = 'queued'::\"ImageTaskStatus\", \"updatedAt\" = now() WHERE \"id\" = :id AND \"status\" = 'processing'::\"ImageTaskStatus\"",
          Map.of("id", task.id()));
        if (updated > 0) {
          clearActive(task.id());
          forceWaiting(task.id());
          recovered += 1;
          continue;
        }
      }
      if (!hasPendingQueueState(task.id())) forceWaiting(task.id());
      recovered += 1;
    }
    if (recovered > 0) redis.opsForValue().increment(key("image:recovered"), recovered);
  }

  public void startWorker() {
    if (!workerEnabled || !started.compareAndSet(false, true)) return;
    executor = Executors.newThreadPerTaskExecutor(Thread.ofVirtual().name("image-worker-", 0).factory());
    for (int index = 0; index < concurrency; index += 1) {
      executor.submit(this::workerLoop);
    }
  }

  public QueueStats stats() {
    runMaintenance();
    long waiting = len("image:waiting");
    long active = size("image:active");
    long completed = value("image:completed");
    long failed = value("image:failed");
    long delayed = zsize("image:delayed");
    long dead = len("image:dead");
    long recovered = value("image:recovered");
    return new QueueStats(waiting, active, completed, failed, delayed, dead, recovered);
  }

  public int concurrency() {
    return concurrency;
  }

  private void workerLoop() {
    while (!Thread.currentThread().isInterrupted()) {
      String taskId = null;
      boolean locked = false;
      AtomicBoolean heartbeat = null;
      try {
        runMaintenance();
        taskId = redis.opsForList().rightPop(key("image:waiting"), Duration.ofSeconds(2));
        if (taskId == null || taskId.isBlank()) continue;
        if (!isQueued(taskId)) {
          redis.opsForSet().remove(key("image:waiting:set"), taskId);
          continue;
        }
        if (isDelayed(taskId)) {
          redis.opsForSet().remove(key("image:waiting:set"), taskId);
          continue;
        }
        locked = Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(
          key("image:lock:" + taskId), String.valueOf(Instant.now().toEpochMilli()), Duration.ofMillis(stalledTaskMs)
        ));
        if (!locked) {
          redis.opsForSet().remove(key("image:waiting:set"), taskId);
          if (!Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:active"), taskId))) {
            redis.opsForSet().add(key("image:delayed:set"), taskId);
            redis.opsForZSet().add(key("image:delayed"), taskId, Instant.now().toEpochMilli() + stalledTaskMs);
          }
          continue;
        }
        redis.opsForSet().remove(key("image:delayed:set"), taskId);
        redis.opsForSet().add(key("image:active"), taskId);
        redis.opsForHash().put(key("image:active:started"), taskId, String.valueOf(Instant.now().toEpochMilli()));
        redis.opsForSet().remove(key("image:waiting:set"), taskId);
        heartbeat = startHeartbeat(taskId);
        ProcessResult result = processOnce(taskId);
        if (result == ProcessResult.SUCCESS) {
          redis.opsForHash().delete(key("image:attempts"), taskId);
          releaseQueueMembership(taskId);
          redis.opsForValue().increment(key("image:completed"));
        } else if (result == ProcessResult.RETRY) {
          scheduleRetry(taskId);
        } else if (result == ProcessResult.SKIPPED) {
          redis.opsForHash().delete(key("image:attempts"), taskId);
          releaseQueueMembership(taskId);
        } else {
          moveToDead(taskId);
          redis.opsForValue().increment(key("image:failed"));
        }
      } catch (Exception exception) {
        if (taskId != null) {
          markWorkerException(taskId, exception);
          redis.opsForValue().increment(key("image:failed"));
        }
      } finally {
        if (heartbeat != null) heartbeat.set(false);
        if (taskId != null && locked) clearActive(taskId);
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
      boolean retryable = upstreamException == null || upstreamException.retryable();
      ImageTask latest = db.imageTaskById(taskId).orElse(null);
      if (latest == null) return ProcessResult.FAILED;
      if ("success".equals(latest.status())) return ProcessResult.SUCCESS;
      if (List.of("failed", "blocked", "cancelled").contains(latest.status())) return ProcessResult.SKIPPED;
      String code = upstreamException == null ? "WORKER_FAILED" : upstreamException.code();
      String message = exception.getMessage() == null ? exception.toString() : exception.getMessage();
      if (retryable && attempt < attempts) {
        db.jdbc().update("""
          UPDATE "ImageTask" SET
            "status" = 'queued'::"ImageTaskStatus",
            "retryCount" = :retryCount,
            "errorCode" = :code,
            "errorMessage" = :message,
            "updatedAt" = now()
          WHERE "id" = :id AND "status" = 'processing'::"ImageTaskStatus"
          """, Map.of(
          "id", taskId,
          "retryCount", attempt,
          "code", code,
          "message", truncate(message, 1000)
        ));
        return ProcessResult.RETRY;
      }
      if (imageService != null) imageService.failTask(latest, code, truncate(message, 1000), true);
      return ProcessResult.FAILED;
    }
  }

  private void scheduleRetry(String taskId) {
    int attempt = attempt(taskId);
    long runAt = Instant.now().toEpochMilli() + Math.max(1000, backoffMs * Math.max(1, attempt));
    redis.opsForSet().add(key("image:delayed:set"), taskId);
    redis.opsForZSet().add(key("image:delayed"), taskId, runAt);
  }

  private void runMaintenance() {
    long now = Instant.now().toEpochMilli();
    long previous = lastMaintenanceAt.get();
    if (now - previous < 1000 || !lastMaintenanceAt.compareAndSet(previous, now)) return;
    releaseDueDelayed();
    recoverStalledActive();
  }

  private void releaseDueDelayed() {
    long now = Instant.now().toEpochMilli();
    var due = redis.opsForZSet().rangeByScore(key("image:delayed"), 0, now, 0, 100);
    if (due == null || due.isEmpty()) return;
    for (String taskId : due) {
      Long removed = redis.opsForZSet().remove(key("image:delayed"), taskId);
      if (removed != null && removed > 0 && Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:queued"), taskId))) {
        redis.opsForSet().remove(key("image:delayed:set"), taskId);
        redis.opsForSet().add(key("image:waiting:set"), taskId);
        redis.opsForList().leftPush(key("image:waiting"), taskId);
      }
    }
  }

  private void recoverStalledActive() {
    Map<Object, Object> active = redis.opsForHash().entries(key("image:active:started"));
    long cutoff = Instant.now().toEpochMilli() - stalledTaskMs;
    for (Map.Entry<Object, Object> entry : active.entrySet()) {
      String taskId = String.valueOf(entry.getKey());
      long startedAt = parseLong(String.valueOf(entry.getValue()));
      ImageTask task = db.imageTaskById(taskId).orElse(null);
      if (task == null || List.of("success", "failed", "blocked", "cancelled").contains(task.status())) {
        clearActive(taskId);
        releaseQueueMembership(taskId);
        continue;
      }
      if (startedAt > 0 && startedAt < cutoff && !Boolean.TRUE.equals(redis.hasKey(key("image:lock:" + taskId)))) {
        clearActive(taskId);
        if ("processing".equals(task.status())) {
          int updated = db.jdbc().update("UPDATE \"ImageTask\" SET \"status\" = 'queued'::\"ImageTaskStatus\", \"updatedAt\" = now() WHERE \"id\" = :id AND \"status\" = 'processing'::\"ImageTaskStatus\"",
            Map.of("id", taskId));
          if (updated == 0) continue;
        }
        forceWaiting(taskId);
        redis.opsForValue().increment(key("image:recovered"));
      }
    }
  }

  private void moveToDead(String taskId) {
    redis.opsForHash().delete(key("image:attempts"), taskId);
    redis.opsForZSet().remove(key("image:delayed"), taskId);
    releaseQueueMembership(taskId);
    redis.opsForList().leftPush(key("image:dead"), taskId);
  }

  private void markWorkerException(String taskId, Exception exception) {
    String message = exception.getMessage() == null ? exception.toString() : exception.getMessage();
    try {
      ImageTask task = db.imageTaskById(taskId).orElse(null);
      if (task == null || List.of("success", "failed", "blocked", "cancelled").contains(task.status())) {
        releaseQueueMembership(taskId);
        return;
      }
      moveToDead(taskId);
      if (imageService != null) imageService.failTask(task, "WORKER_FAILED", truncate(message, 1000), true);
    } catch (Exception ignored) {
    }
  }

  private AtomicBoolean startHeartbeat(String taskId) {
    AtomicBoolean alive = new AtomicBoolean(true);
    long intervalMs = Math.max(10_000L, stalledTaskMs / 3L);
    Thread.ofVirtual().name("image-worker-heartbeat-", 0).start(() -> {
      while (alive.get() && !Thread.currentThread().isInterrupted()) {
        try {
          Thread.sleep(intervalMs);
          if (!alive.get()) break;
          redis.expire(key("image:lock:" + taskId), Duration.ofMillis(stalledTaskMs));
          redis.opsForHash().put(key("image:active:started"), taskId, String.valueOf(Instant.now().toEpochMilli()));
        } catch (InterruptedException exception) {
          Thread.currentThread().interrupt();
        } catch (Exception ignored) {
        }
      }
    });
    return alive;
  }

  private boolean isDelayed(String taskId) {
    Double score = redis.opsForZSet().score(key("image:delayed"), taskId);
    return score != null && score > Instant.now().toEpochMilli();
  }

  private boolean isQueued(String taskId) {
    return Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:queued"), taskId));
  }

  private boolean hasPendingQueueState(String taskId) {
    return isQueued(taskId) && (
      Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:waiting:set"), taskId)) ||
      Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:delayed:set"), taskId)) ||
      Boolean.TRUE.equals(redis.opsForSet().isMember(key("image:active"), taskId))
    );
  }

  private void clearActive(String taskId) {
    redis.opsForSet().remove(key("image:active"), taskId);
    redis.opsForHash().delete(key("image:active:started"), taskId);
  }

  private void forceWaiting(String taskId) {
    redis.opsForSet().add(key("image:queued"), taskId);
    redis.opsForZSet().remove(key("image:delayed"), taskId);
    redis.opsForSet().remove(key("image:delayed:set"), taskId);
    redis.opsForHash().putIfAbsent(key("image:attempts"), taskId, "0");
    if (Boolean.TRUE.equals(redis.opsForSet().add(key("image:waiting:set"), taskId))) {
      redis.opsForList().leftPush(key("image:waiting"), taskId);
    }
  }

  private void releaseQueueMembership(String taskId) {
    redis.opsForSet().remove(key("image:queued"), taskId);
    redis.opsForZSet().remove(key("image:delayed"), taskId);
    redis.opsForSet().remove(key("image:waiting:set"), taskId);
    redis.opsForSet().remove(key("image:delayed:set"), taskId);
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

  private String truncate(String value, int max) {
    if (value == null) return null;
    return value.length() <= max ? value : value.substring(0, max);
  }

  private enum ProcessResult {
    SUCCESS,
    RETRY,
    FAILED,
    SKIPPED
  }

  public record QueueStats(long waiting, long active, long completed, long failed, long delayed, long dead, long recovered) {}
}
