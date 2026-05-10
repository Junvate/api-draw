#!/usr/bin/env node

import { performance } from "node:perf_hooks";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:4173";
const apiKey = process.env.API_KEY || "";
const concurrency = Number(process.env.CONCURRENCY || 10);
const requests = Number(process.env.REQUESTS || 50);
const responseMode = process.env.RESPONSE_MODE || "async";
const size = process.env.SIZE || "2048x2048";
const prompt = process.env.PROMPT || "企业级 API 压测占位图，简洁产品摄影风格";

if (!apiKey) {
  console.error("API_KEY is required");
  process.exit(1);
}

const latencies = [];
let ok = 0;
let failed = 0;
let index = 0;

async function one(i) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": `load-${Date.now()}-${i}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: `${prompt} #${i}`,
      size,
      quality: size === "3840x2160" ? "high" : "medium",
      response_mode: responseMode,
    }),
  });
  const latency = performance.now() - started;
  latencies.push(latency);
  if (response.ok) ok += 1;
  else {
    failed += 1;
    const text = await response.text();
    console.error(`request ${i} failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }
}

async function worker() {
  while (index < requests) {
    const i = index;
    index += 1;
    await one(i);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] || 0;
console.log(JSON.stringify({
  baseUrl,
  requests,
  concurrency,
  ok,
  failed,
  successRate: requests === 0 ? 0 : Number(((ok / requests) * 100).toFixed(2)),
  latencyMs: {
    p50: Math.round(percentile(50)),
    p95: Math.round(percentile(95)),
    p99: Math.round(percentile(99)),
    max: Math.round(latencies.at(-1) || 0),
  },
}, null, 2));
