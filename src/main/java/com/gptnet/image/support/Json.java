package com.gptnet.image.support;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

public final class Json {
  public static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
  public static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

  private Json() {}
}
