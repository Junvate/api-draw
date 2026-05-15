package com.gptnet.image.service;

import com.gptnet.image.support.AppException;
import java.net.IDN;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class OutboundUrlPolicy {
  private final boolean allowPrivate;
  private final Set<String> allowedHosts;

  public OutboundUrlPolicy(
    @Value("${ALLOW_PRIVATE_UPSTREAM_URLS:false}") boolean allowPrivate,
    @Value("${OUTBOUND_ALLOWED_HOSTS:}") String allowedHosts
  ) {
    this.allowPrivate = allowPrivate;
    this.allowedHosts = Arrays.stream(String.valueOf(allowedHosts == null ? "" : allowedHosts).split(","))
      .map(String::trim)
      .filter(host -> !host.isBlank())
      .map(this::normalizeHost)
      .collect(Collectors.toUnmodifiableSet());
  }

  public URI requirePublicHttpUrl(String rawUrl) {
    URI uri = parse(rawUrl);
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    if (!"https".equals(scheme) && !"http".equals(scheme)) {
      throw AppException.badRequest("INVALID_OUTBOUND_URL", "URL 必须是 http:// 或 https:// 地址");
    }
    if (uri.getUserInfo() != null) {
      throw AppException.badRequest("INVALID_OUTBOUND_URL", "URL 不能包含用户信息");
    }
    String host = normalizeHost(uri.getHost());
    if (host.isBlank()) {
      throw AppException.badRequest("INVALID_OUTBOUND_URL", "URL Host 不能为空");
    }
    if (!allowedHosts.isEmpty() && !allowedHosts.contains(host)) {
      throw AppException.badRequest("OUTBOUND_HOST_NOT_ALLOWED", "该上游 Host 未在允许列表中");
    }
    if (!allowPrivate) rejectPrivateHost(host);
    return uri;
  }

  public String requirePublicHttpUrlString(String rawUrl) {
    return requirePublicHttpUrl(rawUrl).toString();
  }

  private URI parse(String rawUrl) {
    try {
      return URI.create(String.valueOf(rawUrl == null ? "" : rawUrl).trim());
    } catch (IllegalArgumentException exception) {
      throw AppException.badRequest("INVALID_OUTBOUND_URL", "URL 格式不正确");
    }
  }

  private void rejectPrivateHost(String host) {
    String lower = host.toLowerCase(Locale.ROOT);
    if (lower.equals("localhost") || lower.endsWith(".localhost") || lower.equals("metadata.google.internal")) {
      throw AppException.badRequest("OUTBOUND_PRIVATE_HOST_BLOCKED", "不允许请求本机或内网地址");
    }
    try {
      for (InetAddress address : InetAddress.getAllByName(host)) {
        if (isPrivateAddress(address)) {
          throw AppException.badRequest("OUTBOUND_PRIVATE_HOST_BLOCKED", "不允许请求本机或内网地址");
        }
      }
    } catch (AppException exception) {
      throw exception;
    } catch (Exception exception) {
      throw AppException.badRequest("INVALID_OUTBOUND_HOST", "上游 Host 无法解析");
    }
  }

  private boolean isPrivateAddress(InetAddress address) {
    if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() ||
      address.isSiteLocalAddress() || address.isMulticastAddress()) {
      return true;
    }
    if (address instanceof Inet4Address) {
      byte[] b = address.getAddress();
      int first = b[0] & 0xff;
      int second = b[1] & 0xff;
      return first == 0
        || first == 10
        || first == 127
        || (first == 169 && second == 254)
        || (first == 172 && second >= 16 && second <= 31)
        || (first == 192 && second == 168)
        || (first == 100 && second >= 64 && second <= 127)
        || (first == 198 && (second == 18 || second == 19))
        || first >= 224;
    }
    if (address instanceof Inet6Address) {
      byte[] b = address.getAddress();
      int first = b[0] & 0xff;
      return (first & 0xfe) == 0xfc;
    }
    return false;
  }

  private String normalizeHost(String host) {
    if (host == null) return "";
    String value = host.trim();
    if (value.endsWith(".")) value = value.substring(0, value.length() - 1);
    return IDN.toASCII(value).toLowerCase(Locale.ROOT);
  }
}
