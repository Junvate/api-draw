package com.gptnet.image;

import com.gptnet.image.service.AuthService;
import com.gptnet.image.service.ImageService;
import com.gptnet.image.service.QueueService;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class GptnetImageApplication {
  public static void main(String[] args) {
    SpringApplication.run(GptnetImageApplication.class, args);
  }

  @Bean
  CommandLineRunner seedDefaults(AuthService authService, ImageService imageService, QueueService queueService) {
    return args -> {
      authService.seedAdmin();
      imageService.seedDefaults();
      queueService.setImageService(imageService);
      queueService.recoverPendingTasks();
      queueService.startWorker();
    };
  }
}
