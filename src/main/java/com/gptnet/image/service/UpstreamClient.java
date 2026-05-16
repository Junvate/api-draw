package com.gptnet.image.service;

import com.gptnet.image.support.Json;
import com.gptnet.image.support.AppException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class UpstreamClient {
  private final OutboundUrlPolicy outboundUrlPolicy;
  private final int maxJsonResponseBytes;
  private final HttpClient http = HttpClient.newBuilder()
    .followRedirects(HttpClient.Redirect.NEVER)
    .connectTimeout(Duration.ofSeconds(30))
    .build();

  public UpstreamClient(
    OutboundUrlPolicy outboundUrlPolicy,
    @Value("${UPSTREAM_MAX_JSON_RESPONSE_MB:96}") int maxJsonResponseMb
  ) {
    this.outboundUrlPolicy = outboundUrlPolicy;
    this.maxJsonResponseBytes = Math.toIntExact(Math.min(
      Integer.MAX_VALUE,
      Math.max(1L, maxJsonResponseMb) * 1024L * 1024L
    ));
  }

  public UpstreamResponse json(String rawUrl, String method, Map<String, String> headers, Object body, int timeoutMs) {
    try {
      URI uri = outboundUrlPolicy.requirePublicHttpUrl(rawUrl);
      HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
        .timeout(Duration.ofMillis(timeoutMs));
      headers.forEach(builder::header);
      if (body == null) {
        builder.method(method == null ? "GET" : method, HttpRequest.BodyPublishers.noBody());
      } else {
        byte[] bytes = Json.MAPPER.writeValueAsBytes(body);
        builder.header("Content-Type", "application/json");
        builder.method(method == null ? "POST" : method, HttpRequest.BodyPublishers.ofByteArray(bytes));
      }
      HttpResponse<InputStream> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
      return parse(response.statusCode(), limitedUtf8(response.body(), maxJsonResponseBytes));
    } catch (AppException exception) {
      throw new UpstreamException("INVALID_UPSTREAM_URL", exception.getMessage(), 0, false);
    } catch (ResponseTooLargeException exception) {
      throw UpstreamException.responseTooLarge(exception.getMessage()).withDebug(rawUrl, null);
    } catch (Exception exception) {
      throw UpstreamException.network(exception.getMessage());
    }
  }

  public UpstreamResponse multipart(String rawUrl, Map<String, String> headers, List<Part> parts, int timeoutMs) {
    try {
      String boundary = "----gptnet-image-" + UUID.randomUUID().toString().replace("-", "");
      byte[] body = multipartBody(boundary, parts);
      URI uri = outboundUrlPolicy.requirePublicHttpUrl(rawUrl);
      HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
        .timeout(Duration.ofMillis(timeoutMs))
        .header("Content-Type", "multipart/form-data; boundary=" + boundary);
      headers.forEach(builder::header);
      HttpResponse<InputStream> response = http.send(
        builder.POST(HttpRequest.BodyPublishers.ofByteArray(body)).build(),
        HttpResponse.BodyHandlers.ofInputStream()
      );
      return parse(response.statusCode(), limitedUtf8(response.body(), maxJsonResponseBytes));
    } catch (AppException exception) {
      throw new UpstreamException("INVALID_UPSTREAM_URL", exception.getMessage(), 0, false);
    } catch (ResponseTooLargeException exception) {
      throw UpstreamException.responseTooLarge(exception.getMessage()).withDebug(rawUrl, null);
    } catch (Exception exception) {
      throw UpstreamException.network(exception.getMessage());
    }
  }

  public String errorMessage(Map<String, Object> payload, String fallback) {
    Object error = payload.get("error");
    if (error instanceof Map<?, ?> map && map.get("message") != null) return String.valueOf(map.get("message"));
    if (payload.get("message") != null) return String.valueOf(payload.get("message"));
    if (error != null) return String.valueOf(error);
    return fallback;
  }

  private UpstreamResponse parse(int status, String text) {
    Map<String, Object> payload = Map.of();
    if (text != null && !text.isBlank()) {
      try {
        payload = Json.MAPPER.readValue(text, Json.MAP);
      } catch (Exception ignored) {
        payload = Map.of();
      }
    }
    return new UpstreamResponse(status, status >= 200 && status < 300, payload, text == null ? "" : text);
  }

  private byte[] multipartBody(String boundary, List<Part> parts) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    for (Part part : parts) {
      output.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
      String disposition = "Content-Disposition: form-data; name=\"" + escape(part.name()) + "\"";
      if (part.filename().isPresent()) disposition += "; filename=\"" + escape(part.filename().orElseThrow()) + "\"";
      output.write((disposition + "\r\n").getBytes(StandardCharsets.UTF_8));
      if (part.contentType().isPresent()) {
        output.write(("Content-Type: " + part.contentType().orElseThrow() + "\r\n").getBytes(StandardCharsets.UTF_8));
      }
      output.write("\r\n".getBytes(StandardCharsets.UTF_8));
      output.write(part.bytes());
      output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }
    output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
    return output.toByteArray();
  }

  private String escape(String value) {
    return String.valueOf(value).replaceAll("[\\r\\n\"]", "_");
  }

  private String limitedUtf8(InputStream input, int maxBytes) throws IOException {
    try (input) {
      byte[] bytes = input.readNBytes(maxBytes + 1);
      if (bytes.length > maxBytes) throw new ResponseTooLargeException("Upstream response too large");
      return new String(bytes, StandardCharsets.UTF_8);
    }
  }

  private static class ResponseTooLargeException extends IOException {
    ResponseTooLargeException(String message) {
      super(message);
    }
  }

  public record UpstreamResponse(int status, boolean ok, Map<String, Object> payload, String text) {}

  public record Part(String name, byte[] bytes, Optional<String> filename, Optional<String> contentType) {
    public static Part text(String name, String value) {
      return new Part(name, String.valueOf(value).getBytes(StandardCharsets.UTF_8), Optional.empty(), Optional.empty());
    }

    public static Part file(String name, byte[] bytes, String filename, String contentType) {
      return new Part(name, bytes, Optional.ofNullable(filename), Optional.ofNullable(contentType));
    }
  }
}
