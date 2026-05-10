import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

let systemCa: Buffer | null | undefined;

function loadSystemCa() {
  if (systemCa !== undefined) return systemCa;
  try {
    systemCa = readFileSync("/etc/ssl/cert.pem");
  } catch {
    systemCa = null;
  }
  return systemCa;
}

export interface UpstreamJsonResponse<T = any> {
  status: number;
  ok: boolean;
  payload: T;
  text: string;
}

export interface UpstreamMultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

export function upstreamJsonRequest<T = any>(
  rawUrl: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<UpstreamJsonResponse<T>> {
  const url = new URL(rawUrl);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = {
    ...(options.headers || {}),
    ...(body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const ca = url.protocol === "https:" ? loadSystemCa() : null;

  return new Promise((resolve, reject) => {
    const req = requester(url, {
      method: options.method || (body ? "POST" : "GET"),
      headers,
      timeout: options.timeoutMs,
      ...(ca ? { ca } : {}),
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let payload: T = {} as T;
        if (text) {
          try {
            payload = JSON.parse(text) as T;
          } catch {
            payload = {} as T;
          }
        }
        const status = res.statusCode || 0;
        resolve({ status, ok: status >= 200 && status < 300, payload, text });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`上游请求超时 ${options.timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export function upstreamMultipartRequest<T = any>(
  rawUrl: string,
  options: {
    method?: "POST";
    headers?: Record<string, string>;
    parts: UpstreamMultipartPart[];
    timeoutMs?: number;
  },
): Promise<UpstreamJsonResponse<T>> {
  const url = new URL(rawUrl);
  const boundary = `----gptnet-image-${randomBytes(12).toString("hex")}`;
  const body = buildMultipartBody(boundary, options.parts);
  const headers = {
    ...(options.headers || {}),
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(body.length),
  };
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const ca = url.protocol === "https:" ? loadSystemCa() : null;

  return new Promise((resolve, reject) => {
    const req = requester(url, {
      method: options.method || "POST",
      headers,
      timeout: options.timeoutMs,
      ...(ca ? { ca } : {}),
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let payload: T = {} as T;
        if (text) {
          try {
            payload = JSON.parse(text) as T;
          } catch {
            payload = {} as T;
          }
        }
        const status = res.statusCode || 0;
        resolve({ status, ok: status >= 200 && status < 300, payload, text });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`上游请求超时 ${options.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildMultipartBody(boundary: string, parts: UpstreamMultipartPart[]) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = [
      `form-data; name="${escapeMultipartHeader(part.name)}"`,
      part.filename ? `filename="${escapeMultipartHeader(part.filename)}"` : null,
    ].filter(Boolean).join("; ");
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n`));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function escapeMultipartHeader(value: string) {
  return String(value || "").replace(/[\r\n"]/g, "_");
}

export function upstreamErrorMessage(payload: any, fallback: string) {
  return payload?.error?.message
    || payload?.message
    || payload?.error
    || fallback;
}
