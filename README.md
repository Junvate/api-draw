# GPTNet Image

Enterprise GPT Image 2 gateway with a Java/Spring Boot backend, PostgreSQL persistence, Redis image task queue, API key access, wallet credits, audit logs, and an `/admin` operations console.

## Run Locally

Start dependencies and sync the database schema:

```bash
# Requires Java 21 and Maven 3.9+ when running outside Docker.
docker compose up -d postgres redis
DATABASE_URL=postgresql://draw:draw@127.0.0.1:5432/draw?schema=public REDIS_URL=redis://127.0.0.1:6379 mvn spring-boot:run
```

Open:

```text
http://127.0.0.1:4173
http://127.0.0.1:4173/admin
```

If you need an initial admin, set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before first startup.

The Spring Boot service in `src/main/java/com/gptnet/image/GptnetImageApplication.java` is the supported runtime path. Flyway initializes the PostgreSQL schema automatically on startup.

## Docker One-Click Deployment

The compose stack includes the app, PostgreSQL, Redis, and persistent Docker volumes. Only the app port is bound to `127.0.0.1` on the host for reverse proxying; PostgreSQL and Redis stay on the Docker network.

```bash
cp .env.docker.example .env
# Edit SESSION_SECRET, POSTGRES_PASSWORD, SEED_ADMIN_EMAIL, and SEED_ADMIN_PASSWORD.
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4173/api/ready
```

If your server cannot pull Docker Hub builder images, build the jar locally or in CI first, then use the runtime-only Dockerfile:

```bash
mvn -DskipTests package
docker build -f Dockerfile.runtime -t draw-app:latest .
docker compose up -d --no-build
```

Open:

```text
http://127.0.0.1:4173
http://127.0.0.1:4173/admin
```

Use your website or Nginx/Caddy/宝塔 reverse proxy to forward HTTPS traffic to `127.0.0.1:4173`.
The recommended production shape is one public domain, for example `https://image.example.com`, with the frontend and `/api/**` served by the same app through the proxy. In that setup browser requests are same-origin and CORS is not involved.
Use HTTPS in production. With `NODE_ENV=production`, session cookies are marked `Secure`, so browser login will not work reliably over plain HTTP.

Nginx example:

```nginx
server {
  listen 80;
  server_name image.example.com;

  location = /api/metrics {
    allow 127.0.0.1;
    deny all;
    proxy_pass http://127.0.0.1:4173;
  }

  location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 32m;
  }
}
```

If a separate frontend domain must call this API directly, set:

```bash
APP_ALLOWED_ORIGINS=https://www.example.com,https://image.example.com
```

Do not use `APP_ALLOWED_ORIGINS=*` for cookie-based login from another domain. Same-domain reverse proxy is simpler and safer.

Do not expose `5432` or `6379` publicly. Database schema migrations are handled by Flyway on app startup.
For admin safety, keep `SEED_ADMIN_PASSWORD` strong before first startup, restrict `/admin` by IP or an extra reverse-proxy auth layer if possible, and monitor repeated `429`/`401` login responses.

## Architecture

Current backend stack:

- Java 21 + Spring Boot service modules
- PostgreSQL via Spring JDBC + Flyway for users, tenants, API keys, image tasks, results, wallet ledger, usage records, gateways, audit logs, plans, and redemption codes
- Redis-backed asynchronous image generation queue and worker
- Admin console at `/admin` for users, API keys, gateways, jobs, redemption codes, audit logs, metrics, and readiness probes
- API key gateway at `/api/v1/images/generations`
- Local generated image storage under `storage/images`, with S3/R2/OSS-compatible object storage available through `STORAGE_PROVIDER=s3`

## Production Runtime

Required:

```bash
NODE_ENV=production
SESSION_SECRET=<long-random-secret>
DATABASE_URL=postgresql://draw:draw@postgres:5432/draw?schema=public
REDIS_URL=redis://redis:6379
```

Useful controls:

```bash
PORT=4173
TRUST_PROXY=1
REDIS_KEY_PREFIX=draw:
DB_POOL_MAX_SIZE=50
GATEWAY_QUEUE_LIMIT=5000
GATEWAY_FAILURE_THRESHOLD=30
GATEWAY_COOLDOWN_MS=300000
IMAGE_WORKER_CONCURRENCY=200
IMAGE_JOB_ATTEMPTS=3
IMAGE_JOB_BACKOFF_MS=5000
IMAGE_STALLED_TASK_MS=600000
ALLOW_PRIVATE_UPSTREAM_URLS=false
OUTBOUND_ALLOWED_HOSTS=
GENERATION_IP_RPM=60
GENERATION_USER_RPM=30
GENERATION_API_KEY_RPM=120
AUTH_IP_RPM=20
AUTH_IDENTITY_RPM=6
ADMIN_AUTH_IP_RPM=10
ADMIN_AUTH_IDENTITY_RPM=3
API_KEY_LAST_USED_WRITE_INTERVAL_MS=300000
REQUEST_TIMEOUT_MS=120000
LOCAL_STORAGE_DIR=storage
BODY_LIMIT=2mb
LOG_LEVEL=info
```

Real image gateways are configured in `/admin`. Put the upstream Base URL, model, group, and the real `sk-...` API key in the gateway row. Runtime environment variables are not used as fallback gateway keys.

S3/R2/OSS-compatible result storage:

```bash
STORAGE_PROVIDER=s3
STORAGE_PUBLIC_BASE_URL=https://cdn.example.com
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=draw-images
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
```

## API Service

Admins issue API keys from `/admin`, then clients call with `Authorization: Bearer`.

Create a generation task:

```bash
curl -X POST http://127.0.0.1:4173/api/v1/images/generations \
  -H "Authorization: Bearer <api-key>" \
  -H "Idempotency-Key: request-001" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A clean enterprise product concept image",
    "model": "gpt-image-2",
    "size": "2048x2048",
    "quality": "medium",
    "response_mode": "async"
  }'
```

The API returns `202` with a task payload. Poll:

```bash
curl http://127.0.0.1:4173/api/v1/images/generations/<task-id> \
  -H "Authorization: Bearer <api-key>"
```

`Idempotency-Key` prevents duplicate task creation and duplicate credit holds for client retries.

## Operations

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/ready
curl http://127.0.0.1:4173/api/metrics
curl http://127.0.0.1:4173/api/openapi.json
```

Container runtime:

```bash
docker compose up --build app
```

Load test:

```bash
API_KEY=<api-key-issued-in-admin> CONCURRENCY=20 REQUESTS=100 RESPONSE_MODE=async node scripts/load-test.mjs
```

## Enterprise Notes

This version has moved beyond the original file-store demo: readiness now reports `store: "postgresql"`, Redis handles queued image work with delayed retries and a dead-letter list, task results are represented as durable service URLs, and `/api/metrics` exposes queue and gateway counters. For higher production maturity, run multiple app instances behind Kong/APISIX/Nginx, wire `/api/metrics` into Prometheus/Grafana alerts, and verify the target concurrency with `scripts/load-test.mjs` before opening traffic.
