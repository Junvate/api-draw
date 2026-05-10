package com.gptnet.image.support;

import java.security.SecureRandom;
import java.util.UUID;

public final class Ids {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final char[] BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".toCharArray();

  private Ids() {}

  public static String id() {
    return "j" + UUID.randomUUID().toString().replace("-", "");
  }

  public static String randomBase62(int length) {
    char[] value = new char[length];
    for (int index = 0; index < length; index += 1) value[index] = BASE62[RANDOM.nextInt(BASE62.length)];
    return new String(value);
  }
}
