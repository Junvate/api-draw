package com.gptnet.image.support;

import java.util.LinkedHashMap;
import java.util.Map;

public final class Maps {
  private Maps() {}

  public static Map<String, Object> of(Object... pairs) {
    if (pairs.length % 2 != 0) throw new IllegalArgumentException("Map pairs must be even");
    Map<String, Object> map = new LinkedHashMap<>();
    for (int index = 0; index < pairs.length; index += 2) {
      map.put(String.valueOf(pairs[index]), pairs[index + 1]);
    }
    return map;
  }
}
