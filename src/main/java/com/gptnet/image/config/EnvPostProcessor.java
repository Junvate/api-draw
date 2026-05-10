package com.gptnet.image.config;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

public class EnvPostProcessor implements EnvironmentPostProcessor, Ordered {
  @Override
  public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
    Map<String, Object> props = new LinkedHashMap<>();
    readDotEnv(props);

    String databaseUrl = firstNonBlank(environment.getProperty("DATABASE_URL"), (String) props.get("DATABASE_URL"));
    if (databaseUrl != null && !environment.containsProperty("spring.datasource.url")) {
      JdbcUrl jdbcUrl = toJdbcUrl(databaseUrl);
      props.put("spring.datasource.url", jdbcUrl.url());
      if (jdbcUrl.username() != null) props.put("spring.datasource.username", jdbcUrl.username());
      if (jdbcUrl.password() != null) props.put("spring.datasource.password", jdbcUrl.password());
    }

    String redisUrl = firstNonBlank(environment.getProperty("REDIS_URL"), (String) props.get("REDIS_URL"));
    if (redisUrl != null && !environment.containsProperty("spring.data.redis.url")) {
      props.put("spring.data.redis.url", redisUrl);
    }

    environment.getPropertySources().addLast(new MapPropertySource("gptnet-env", props));
  }

  private void readDotEnv(Map<String, Object> props) {
    Path path = Path.of(".env");
    if (!Files.isRegularFile(path)) return;
    Map<String, String> raw = new LinkedHashMap<>();
    try {
      for (String line : Files.readAllLines(path)) {
        String trimmed = line.trim();
        if (trimmed.isBlank() || trimmed.startsWith("#")) continue;
        int index = trimmed.indexOf('=');
        if (index <= 0) continue;
        String key = trimmed.substring(0, index).trim();
        String value = trimmed.substring(index + 1).trim();
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length() - 1);
        }
        raw.put(key, value);
      }
    } catch (IOException ignored) {
      return;
    }
    for (String key : raw.keySet()) {
      if (System.getenv(key) == null && System.getProperty(key) == null) {
        props.put(key, raw.get(key));
      }
    }
  }

  private JdbcUrl toJdbcUrl(String databaseUrl) {
    String raw = databaseUrl.trim();
    if (raw.startsWith("jdbc:")) return new JdbcUrl(raw, null, null);
    java.net.URI uri = java.net.URI.create(raw);
    String userInfo = uri.getUserInfo();
    String username = null;
    String password = null;
    if (userInfo != null) {
      String[] parts = userInfo.split(":", 2);
      username = urlDecode(parts[0]);
      password = parts.length > 1 ? urlDecode(parts[1]) : "";
    }
    String query = uri.getRawQuery();
    String schema = null;
    StringBuilder jdbcQuery = new StringBuilder();
    if (query != null && !query.isBlank()) {
      for (String param : query.split("&")) {
        int index = param.indexOf('=');
        String key = index >= 0 ? param.substring(0, index) : param;
        String value = index >= 0 ? param.substring(index + 1) : "";
        if ("schema".equals(key)) schema = urlDecode(value);
        else {
          if (!jdbcQuery.isEmpty()) jdbcQuery.append('&');
          jdbcQuery.append(param);
        }
      }
    }
    if (schema != null && !schema.isBlank()) {
      if (!jdbcQuery.isEmpty()) jdbcQuery.append('&');
      jdbcQuery.append("currentSchema=").append(schema);
    }
    int port = uri.getPort() > 0 ? uri.getPort() : 5432;
    String jdbc = "jdbc:postgresql://" + uri.getHost() + ":" + port + uri.getPath();
    if (!jdbcQuery.isEmpty()) jdbc += "?" + jdbcQuery;
    return new JdbcUrl(jdbc, username, password);
  }

  private String firstNonBlank(String first, String second) {
    if (first != null && !first.isBlank()) return first;
    if (second != null && !second.isBlank()) return second;
    return null;
  }

  private String urlDecode(String value) {
    return java.net.URLDecoder.decode(value, java.nio.charset.StandardCharsets.UTF_8);
  }

  @Override
  public int getOrder() {
    return Ordered.HIGHEST_PRECEDENCE + 10;
  }

  private record JdbcUrl(String url, String username, String password) {}
}
