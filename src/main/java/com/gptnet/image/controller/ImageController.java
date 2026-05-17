package com.gptnet.image.controller;

import com.gptnet.image.dto.CreateImageRequest;
import com.gptnet.image.model.ImageTask;
import com.gptnet.image.model.User;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api")
public class ImageController {
  private final AuthService auth;
  private final ImageService imageService;
  private final Db db;
  private final RateLimitService rateLimit;

  public ImageController(AuthService auth, ImageService imageService, Db db, RateLimitService rateLimit) {
    this.auth = auth;
    this.imageService = imageService;
    this.db = db;
    this.rateLimit = rateLimit;
  }

  @PostMapping(value = "/generate", consumes = MediaType.APPLICATION_JSON_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> generateJson(HttpServletRequest request, @Valid @RequestBody CreateImageRequest body) {
    return generateInternal(request, body, List.of());
  }

  @PostMapping(value = "/generate", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> generateMultipart(
    HttpServletRequest request,
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
    return generateInternal(request, body, mergeFiles(files, imageArrayFiles));
  }

  @GetMapping("/credits/history")
  public Map<String, Object> creditsHistory(
    HttpServletRequest request,
    @RequestParam(defaultValue = "50") int limit,
    @RequestParam(defaultValue = "0") int offset
  ) {
    User user = auth.validateSession(request);
    int safeLimit = Math.min(limit, 100);
    return Maps.of(
      "entries", db.walletHistory(user.id(), safeLimit, offset),
      "credits", db.walletBalance(user.id())
    );
  }

  @GetMapping("/jobs")
  public Map<String, Object> jobs(HttpServletRequest request) {
    User user = auth.validateSession(request);
    List<ImageTask> tasks = "admin".equals(user.role()) ? db.recentTasks(20) : db.recentTasksForUser(user.id(), 20);
    return Maps.of("jobs", tasks.stream().map(task -> {
      ImageTask hydrated = db.hydrateTask(task);
      Map<String, Object> item = imageService.publicTask(hydrated, user.id(), false);
      if (hydrated.user() != null) {
        item.put("ownerEmail", hydrated.user().email());
        item.put("ownerName", hydrated.user().name());
      }
      item.put("ownedByMe", hydrated.userId().equals(user.id()));
      return item;
    }).toList());
  }

  @GetMapping("/jobs/{taskId}")
  public Map<String, Object> job(HttpServletRequest request, @PathVariable String taskId) {
    User user = auth.validateSession(request);
    ImageTask task = ("admin".equals(user.role()) ? db.imageTaskById(taskId) : db.imageTaskByIdAndUser(taskId, user.id()))
      .map(db::hydrateTask)
      .orElseThrow(() -> AppException.notFound("任务不存在"));
    Map<String, Object> item = imageService.publicTask(task, user.id());
    if (task.user() != null) {
      item.put("ownerEmail", task.user().email());
      item.put("ownerName", task.user().name());
    }
    item.put("ownedByMe", task.userId().equals(user.id()));
    return Maps.of("job", item);
  }

  private Map<String, Object> generateInternal(HttpServletRequest request, CreateImageRequest body, List<MultipartFile> files) {
    User user = auth.validateSession(request);
    rateLimit.checkSessionGeneration(request, user.id());
    ImageTask task = imageService.createTask(new ImageService.CreateTaskParams(user.id(), null, null, body, files));
    boolean sync = "sync".equalsIgnoreCase(String.valueOf(body.getResponse_mode()));
    ImageTask returned = sync ? imageService.processTask(task.id(), 1, 1) : imageService.queueTask(task);
    if (returned != null && "failed".equals(returned.status()) && sync) {
      throw AppException.unavailable(returned.errorCode() == null ? "GENERATION_FAILED" : returned.errorCode(), returned.errorMessage());
    }
    return Maps.of(
      "job", imageService.publicTask(returned, user.id(), sync),
      "credits", db.walletBalance(user.id())
    );
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
