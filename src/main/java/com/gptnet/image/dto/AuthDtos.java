package com.gptnet.image.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public final class AuthDtos {
  private AuthDtos() {}

  public static class RegisterRequest {
    @Email
    @Size(max = 254)
    private String email;
    @NotBlank
    @Size(min = 8, max = 256)
    private String password;
    @Size(max = 80)
    private String name;

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
  }

  public static class LoginRequest {
    @Email
    @Size(max = 254)
    private String email;
    @NotBlank
    @Size(max = 256)
    private String password;

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
  }
}
