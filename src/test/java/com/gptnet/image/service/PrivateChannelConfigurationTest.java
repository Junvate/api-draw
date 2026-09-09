package com.gptnet.image.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.gptnet.image.model.ImageTask;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;

class PrivateChannelConfigurationTest {
  @Test
  void configuredHostsKeepTheAlternativeRequestFormat() {
    Map<String, Object> body = requestBody(" OTHER.EXAMPLE, API.EXAMPLE.COM , ", "https://api.example.com/v1/images/generations");

    assertThat(body).containsEntry("format", "jpeg").containsEntry("n", 2);
    assertThat(body).doesNotContainKeys("output_format", "background");
  }

  @Test
  void unconfiguredHostsUseTheStandardRequestFormat() {
    Map<String, Object> body = requestBody("", "https://api.example.com/v1/images/generations");

    assertThat(body).containsEntry("output_format", "jpeg").containsEntry("background", "auto");
    assertThat(body).doesNotContainKey("format");
  }

  @ParameterizedTest
  @NullAndEmptySource
  @ValueSource(strings = {
    "not a url",
    "https://api.example.com.attacker.example/v1/images/generations",
    "https://other.example/api.example.com/images/generations",
    "https://other.example/v1/images/generations?host=api.example.com",
    "https://api.example.com/v1/images/edits"
  })
  void hostOverridesRequireAnExactHostAndGenerationPath(String url) {
    assertThat(requestBody("api.example.com", url)).containsKey("output_format").doesNotContainKey("format");
  }

  @Test
  void onlyTheConfiguredLegacyTesterEndpointIsRemapped() {
    AdminService service = new AdminService(null, null, null, null, null, null,
      " https://api.example.com/v1/images/generations ", " https://api.example.com/v1/chat/completions ");

    assertThat(normalizeTesterUrl(service, "HTTPS://API.EXAMPLE.COM/v1/chat/completions"))
      .isEqualTo("https://api.example.com/v1/images/generations");
    assertThat(normalizeTesterUrl(service, "https://other.example/v1/chat/completions"))
      .isEqualTo("https://other.example/v1/chat/completions");
  }

  @Test
  void noPrivateTesterEndpointIsSelectedByDefault() {
    AdminService service = new AdminService(null, null, null, null, null, null, "", "");

    assertThat(normalizeTesterUrl(service, "")).isEmpty();
    assertThat(normalizeTesterUrl(service, "https://api.example.com/v1/chat/completions"))
      .isEqualTo("https://api.example.com/v1/chat/completions");
  }

  private String normalizeTesterUrl(AdminService service, String url) {
    return ReflectionTestUtils.invokeMethod(service, "normalizeCallSquareConfigUrl", url);
  }

  private Map<String, Object> requestBody(String hosts, String url) {
    ImageService service = new ImageService(null, null, null, null, null, null, null, null,
      "storage", 30, 300000, hosts);
    ImageTask task = new ImageTask("task", "user", null, "gateway", null, "gpt-image-2", "test prompt", null,
      "1024x1024", "low", "jpg", "auto", 2, "queued", null, null, null, null, 0, 3, 8, null,
      null, null, null, null, List.of(), null, null);
    return ReflectionTestUtils.invokeMethod(service, "imageGenerationRequestBody", url, task, 2);
  }
}
