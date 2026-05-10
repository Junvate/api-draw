package com.gptnet.image.support;

import java.util.Map;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

@RestControllerAdvice
public class GlobalExceptionHandler {
  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  @ExceptionHandler(AppException.class)
  ResponseEntity<Map<String, Object>> app(AppException exception) {
    return ResponseEntity.status(exception.status()).body(Maps.of(
      "error", exception.code(),
      "message", exception.getMessage()
    ));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  ResponseEntity<Map<String, Object>> validation(MethodArgumentNotValidException exception) {
    FieldError first = exception.getBindingResult().getFieldErrors().stream().findFirst().orElse(null);
    String message = first == null ? "参数不正确" : first.getField() + " " + first.getDefaultMessage();
    return ResponseEntity.badRequest().body(Maps.of("error", "VALIDATION_FAILED", "message", message));
  }

  @ExceptionHandler({MethodArgumentTypeMismatchException.class, IllegalArgumentException.class})
  ResponseEntity<Map<String, Object>> badRequest(Exception exception) {
    return ResponseEntity.badRequest().body(Maps.of("error", "VALIDATION_FAILED", "message", exception.getMessage()));
  }

  @ExceptionHandler(DuplicateKeyException.class)
  ResponseEntity<Map<String, Object>> duplicate(DuplicateKeyException exception) {
    return ResponseEntity.status(HttpStatus.CONFLICT).body(Maps.of("error", "CONFLICT", "message", "数据已存在"));
  }

  @ExceptionHandler(MaxUploadSizeExceededException.class)
  ResponseEntity<Map<String, Object>> upload(MaxUploadSizeExceededException exception) {
    return ResponseEntity.badRequest().body(Maps.of("error", "UPLOAD_TOO_LARGE", "message", "上传文件过大"));
  }

  @ExceptionHandler(NoResourceFoundException.class)
  ResponseEntity<Map<String, Object>> missingResource(NoResourceFoundException exception) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Maps.of("error", "NOT_FOUND", "message", "资源不存在"));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Map<String, Object>> generic(Exception exception) {
    log.error("Unhandled request error", exception);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Maps.of(
      "error", "INTERNAL_ERROR",
      "message", "服务器内部错误"
    ));
  }
}
