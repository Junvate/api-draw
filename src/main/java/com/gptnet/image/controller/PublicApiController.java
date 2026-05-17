package com.gptnet.image.controller;

import com.gptnet.image.dto.CreateImageRequest;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.service.AuthService;
import com.gptnet.image.service.Db;
import com.gptnet.image.service.ImageService;
import com.gptnet.image.service.RateLimitService;
import com.gptnet.image.support.AppException;
import com.gptnet.image.support.Maps;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1")
public class PublicApiController {
  private final AuthService auth;
  private final ImageService imageService;
  private final Db db;
  private final RateLimitService rateLimit;

  public PublicApiController(AuthService auth, ImageService imageService, Db db, RateLimitService rateLimit) {
    this.auth = auth;
    this.imageService = imageService;
    this.db = db;
    this.rateLimit = rateLimit;
  }

  @GetMapping("/me")
  public Map<String, Object> me(HttpServletRequest request) {
    AuthService.AuthContext context = auth.validateApiKey(request, "images.generate");
    return Maps.of(
      "object", "account",
      "user", auth.publicUser(context.user()),
      "api_key", auth.publicApiKey(context.apiKey())
    );
  }

  @PostMapping(value = "/images/generations", consumes = MediaType.APPLICATION_JSON_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> createJson(
    HttpServletRequest request,
    @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
    @Valid @RequestBody CreateImageRequest body
  ) {
    return createInternal(request, idempotencyKey, body, List.of());
  }

  @PostMapping(value = "/images/generations", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> createMultipart(
    HttpServletRequest request,
    @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
    @RequestParam String prompt,
    @RequestParam(required = false) String model,
    @RequestParam(required = false) String ratio,
    @RequestParam(required = false) String size,
    @RequestParam(required = false) String quality,
    @RequestParam(value = "output_format", required = false) String outputFormat,
    @RequestParam(required = false) String background,
    @RequestParam(required = false) Integer refs,
    @RequestParam(value = "response_mode", required = false) String responseMode,
    @RequestPart(value = "image", required = false) List<MultipartFile> files,
    @RequestPart(value = "image[]", required = false) List<MultipartFile> imageArrayFiles
  ) {
    CreateImageRequest body = multipartBody(prompt, model, ratio, size, quality, outputFormat, background, refs, responseMode);
    return createInternal(request, idempotencyKey, body, mergeFiles(files, imageArrayFiles));
  }

  @PostMapping(value = "/images/edits", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> editMultipart(
    HttpServletRequest request,
    @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
    @RequestParam String prompt,
    @RequestParam(required = false) String model,
    @RequestParam(required = false) String ratio,
    @RequestParam(required = false) String size,
    @RequestParam(required = false) String quality,
    @RequestParam(value = "output_format", required = false) String outputFormat,
    @RequestParam(required = false) String background,
    @RequestParam(required = false) Integer refs,
    @RequestParam(value = "response_mode", required = false) String responseMode,
    @RequestPart(value = "image", required = false) List<MultipartFile> files,
    @RequestPart(value = "image[]", required = false) List<MultipartFile> imageArrayFiles
  ) {
    CreateImageRequest body = multipartBody(prompt, model, ratio, size, quality, outputFormat, background, refs, responseMode);
    return createInternal(request, idempotencyKey, body, mergeFiles(files, imageArrayFiles));
  }

  @PostMapping(value = "/images/edits", consumes = MediaType.APPLICATION_JSON_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> editJson(
    HttpServletRequest request,
    @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
    @Valid @RequestBody CreateImageRequest body
  ) {
    return createInternal(request, idempotencyKey, body, List.of());
  }

  @GetMapping("/images/generations/{taskId}")
  public Map<String, Object> getTask(HttpServletRequest request, @PathVariable String taskId) {
    AuthService.AuthContext context = auth.validateApiKey(request, "images.generate");
    ImageTask task = db.imageTaskByIdAndUser(taskId, context.user().id())
      .map(db::hydrateTask)
      .orElseThrow(() -> AppException.notFound("任务不存在"));
    return Maps.of("object", "image_generation.response", "data", imageService.publicTask(task, context.user().id()));
  }

  private Map<String, Object> createInternal(HttpServletRequest request, String idempotencyKey, CreateImageRequest body, List<MultipartFile> files) {
    AuthService.AuthContext context = auth.validateApiKey(request, "images.generate");
    rateLimit.checkApiGeneration(request, context.apiKey().id());
    String requestId = idempotencyKey == null || idempotencyKey.isBlank() ? null : idempotencyKey.trim();
    if (requestId != null) {
      var existing = db.imageTaskByApiKeyAndRequest(context.apiKey().id(), requestId).map(db::hydrateTask);
      if (existing.isPresent()) {
        ImageTask task = imageService.ensureQueued(existing.get());
        return Maps.of("object", "image_generation.response", "data", imageService.publicTask(task, context.user().id()));
      }
    }
    ImageTask task = imageService.createTask(new ImageService.CreateTaskParams(context.user().id(), context.apiKey().id(), requestId, body, files));
    boolean sync = "sync".equalsIgnoreCase(String.valueOf(body.getResponse_mode()));
    ImageTask returned = sync ? imageService.processTask(task.id(), 1, 1) : imageService.queueTask(task);
    if (returned != null && "failed".equals(returned.status()) && sync) {
      throw AppException.unavailable(returned.errorCode() == null ? "GENERATION_FAILED" : returned.errorCode(), returned.errorMessage());
    }
    return Maps.of("object", "image_generation.response", "data", imageService.publicTask(returned, context.user().id(), sync));
  }

  private CreateImageRequest multipartBody(String prompt, String model, String ratio, String size, String quality, String outputFormat, String background, Integer refs, String responseMode) {
    CreateImageRequest body = new CreateImageRequest();
    body.setPrompt(prompt);
    body.setModel(model);
    body.setRatio(ratio);
    body.setSize(size);
    body.setQuality(quality);
    body.setOutput_format(outputFormat);
    body.setBackground(background);
    body.setRefs(refs);
    body.setResponse_mode(responseMode);
    return body;
  }

  private List<MultipartFile> mergeFiles(List<MultipartFile> first, List<MultipartFile> second) {
    return java.util.stream.Stream.concat(
      first == null ? java.util.stream.Stream.empty() : first.stream(),
      second == null ? java.util.stream.Stream.empty() : second.stream()
    ).toList();
  }
}
