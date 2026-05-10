package com.gptnet.image.service;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class StorageService {
  private static final HexFormat HEX = HexFormat.of();

  private final String provider;
  private final String localRoot;
  private final String publicBaseUrl;
  private final String s3Endpoint;
  private final String s3Region;
  private final String s3Bucket;
  private final String s3AccessKey;
  private final String s3SecretKey;
  private final HttpClient http = HttpClient.newHttpClient();

  public StorageService(
    @Value("${STORAGE_PROVIDER:local}") String provider,
    @Value("${LOCAL_STORAGE_DIR:storage}") String localRoot,
    @Value("${STORAGE_PUBLIC_BASE_URL:}") String publicBaseUrl,
    @Value("${S3_ENDPOINT:}") String s3Endpoint,
    @Value("${S3_REGION:auto}") String s3Region,
    @Value("${S3_BUCKET:}") String s3Bucket,
    @Value("${S3_ACCESS_KEY_ID:}") String s3AccessKey,
    @Value("${S3_SECRET_ACCESS_KEY:}") String s3SecretKey
  ) {
    this.provider = provider == null || provider.isBlank() ? "local" : provider.trim().toLowerCase();
    this.localRoot = localRoot;
    this.publicBaseUrl = publicBaseUrl == null ? "" : publicBaseUrl.trim().replaceAll("/$", "");
    this.s3Endpoint = s3Endpoint == null ? "" : s3Endpoint.trim().replaceAll("/$", "");
    this.s3Region = s3Region == null || s3Region.isBlank() ? "auto" : s3Region.trim();
    this.s3Bucket = s3Bucket == null ? "" : s3Bucket.trim();
    this.s3AccessKey = s3AccessKey == null ? "" : s3AccessKey.trim();
    this.s3SecretKey = s3SecretKey == null ? "" : s3SecretKey.trim();
  }

  public StoredObject putImage(String taskId, String extension, byte[] bytes, String contentType) throws IOException {
    String safeExtension = extension == null || extension.isBlank() ? "png" : extension.replaceAll("[^A-Za-z0-9]", "").toLowerCase();
    String storageKey = "images/" + taskId + "." + safeExtension;
    if ("s3".equals(provider) || "r2".equals(provider) || "oss".equals(provider)) {
      String hash = sha256(bytes);
      putS3(storageKey, bytes, contentType, hash);
      String url = publicBaseUrl.isBlank() ? s3Endpoint + "/" + s3Bucket + "/" + storageKey : publicBaseUrl + "/" + storageKey;
      return new StoredObject(storageKey, url, bytes.length, hash, contentType);
    }
    if (!"local".equals(provider)) throw new StorageException("Unsupported STORAGE_PROVIDER=" + provider);
    Path dir = Path.of(localRoot, "images");
    Files.createDirectories(dir);
    String filename = taskId + "." + safeExtension;
    Path file = dir.resolve(filename);
    Files.write(file, bytes);
    String url = publicBaseUrl.isBlank() ? "/api/images/" + taskId + "/result" : publicBaseUrl + "/" + storageKey;
    return new StoredObject(storageKey, url, bytes.length, sha256(bytes), contentType);
  }

  private void putS3(String storageKey, byte[] bytes, String contentType, String payloadHash) throws IOException {
    if (s3Endpoint.isBlank() || s3Bucket.isBlank() || s3AccessKey.isBlank() || s3SecretKey.isBlank()) {
      throw new StorageException("S3/R2/OSS storage is not fully configured");
    }
    try {
      URI endpoint = URI.create(s3Endpoint);
      String encodedKey = encodePath(storageKey);
      String canonicalUri = "/" + s3Bucket + "/" + encodedKey;
      URI uri = URI.create(s3Endpoint + canonicalUri);
      Instant now = Instant.now();
      String amzDate = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC).format(now);
      String date = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC).format(now);
      String host = endpoint.getHost() + (endpoint.getPort() == -1 ? "" : ":" + endpoint.getPort());
      String credentialScope = date + "/" + s3Region + "/s3/aws4_request";
      String canonicalHeaders = "content-type:" + contentType + "\n" +
        "host:" + host.toLowerCase(Locale.ROOT) + "\n" +
        "x-amz-content-sha256:" + payloadHash + "\n" +
        "x-amz-date:" + amzDate + "\n";
      String signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
      String canonicalRequest = "PUT\n" + canonicalUri + "\n\n" + canonicalHeaders + "\n" + signedHeaders + "\n" + payloadHash;
      String stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + credentialScope + "\n" + sha256(canonicalRequest.getBytes(StandardCharsets.UTF_8));
      String signature = hmacHex(signingKey(date), stringToSign);
      String authorization = "AWS4-HMAC-SHA256 Credential=" + s3AccessKey + "/" + credentialScope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
      HttpResponse<String> response = http.send(HttpRequest.newBuilder(uri)
        .PUT(HttpRequest.BodyPublishers.ofByteArray(bytes))
        .header("Authorization", authorization)
        .header("Content-Type", contentType)
        .header("x-amz-content-sha256", payloadHash)
        .header("x-amz-date", amzDate)
        .build(), HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() < 200 || response.statusCode() >= 300) {
        throw new StorageException("Object storage PUT failed: HTTP " + response.statusCode() + " " + response.body());
      }
    } catch (IOException exception) {
      throw exception;
    } catch (Exception exception) {
      throw new StorageException("Object storage PUT failed", exception);
    }
  }

  private String encodePath(String path) {
    String[] parts = path.split("/");
    StringBuilder builder = new StringBuilder();
    for (int index = 0; index < parts.length; index += 1) {
      if (index > 0) builder.append("/");
      builder.append(URLEncoder.encode(parts[index], StandardCharsets.UTF_8).replace("+", "%20"));
    }
    return builder.toString();
  }

  private byte[] signingKey(String date) throws Exception {
    byte[] kDate = hmac(("AWS4" + s3SecretKey).getBytes(StandardCharsets.UTF_8), date);
    byte[] kRegion = hmac(kDate, s3Region);
    byte[] kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  }

  private byte[] hmac(byte[] key, String data) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(key, "HmacSHA256"));
    return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
  }

  private String hmacHex(byte[] key, String data) throws Exception {
    return HEX.formatHex(hmac(key, data));
  }

  private String sha256(byte[] bytes) throws IOException {
    try {
      return HEX.formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception exception) {
      throw new IOException("Cannot hash object", exception);
    }
  }

  public record StoredObject(String storageKey, String url, int sizeBytes, String hash, String contentType) {}

  public static class StorageException extends IOException {
    public StorageException(String message) {
      super(message);
    }

    public StorageException(String message, Throwable cause) {
      super(message, cause);
    }
  }
}
