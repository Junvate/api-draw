package com.gptnet.image.config;

import java.nio.file.Path;
import java.util.Arrays;
import org.springframework.context.annotation.Configuration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {
  private final String allowedOrigins;

  public WebConfig(@Value("${APP_ALLOWED_ORIGINS:}") String allowedOrigins) {
    this.allowedOrigins = allowedOrigins == null ? "" : allowedOrigins.trim();
  }

  @Override
  public void addResourceHandlers(ResourceHandlerRegistry registry) {
    String publicDir = Path.of("public").toAbsolutePath().normalize().toUri().toString();
    registry.addResourceHandler("/**")
      .addResourceLocations(publicDir)
      .setCacheControl(CacheControl.noCache());
  }

  @Override
  public void addCorsMappings(CorsRegistry registry) {
    var registration = registry.addMapping("/api/**")
      .allowedMethods("GET", "POST", "PATCH", "DELETE", "OPTIONS")
      .allowedHeaders("*");
    if (allowedOrigins.isBlank()) {
      registration.allowedOrigins("*");
    } else {
      String[] origins = Arrays.stream(allowedOrigins.split(","))
        .map(String::trim)
        .filter(origin -> !origin.isBlank())
        .toArray(String[]::new);
      if (origins.length == 0) registration.allowedOrigins("*");
      else registration.allowedOrigins(origins).allowCredentials(true);
    }
  }
}
