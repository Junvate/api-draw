package com.gptnet.image.support;

import org.springframework.http.HttpStatus;

public class AppException extends RuntimeException {
  private final HttpStatus status;
  private final String code;

  public AppException(HttpStatus status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public HttpStatus status() {
    return status;
  }

  public String code() {
    return code;
  }

  public static AppException badRequest(String code, String message) {
    return new AppException(HttpStatus.BAD_REQUEST, code, message);
  }

  public static AppException unauthorized(String code, String message) {
    return new AppException(HttpStatus.UNAUTHORIZED, code, message);
  }

  public static AppException forbidden(String code, String message) {
    return new AppException(HttpStatus.FORBIDDEN, code, message);
  }

  public static AppException notFound(String message) {
    return new AppException(HttpStatus.NOT_FOUND, "NOT_FOUND", message);
  }

  public static AppException conflict(String code, String message) {
    return new AppException(HttpStatus.CONFLICT, code, message);
  }

  public static AppException unavailable(String code, String message) {
    return new AppException(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }

  public static AppException tooManyRequests(String code, String message) {
    return new AppException(HttpStatus.TOO_MANY_REQUESTS, code, message);
  }
}
