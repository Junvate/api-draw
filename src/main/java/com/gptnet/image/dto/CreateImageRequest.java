package com.gptnet.image.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

public class CreateImageRequest {
  @Size(min = 4, max = 8000)
  private String prompt;
  @Size(max = 120)
  private String model;
  @Size(max = 40)
  private String ratio;
  @Size(max = 40)
  private String size;
  @Size(max = 40)
  private String quality;
  @Size(max = 40)
  private String output_format;
  @Size(max = 40)
  private String background;
  @Min(0)
  @Max(3)
  private Integer refs;
  private String response_mode;

  public String getPrompt() { return prompt; }
  public void setPrompt(String prompt) { this.prompt = prompt; }
  public String getModel() { return model; }
  public void setModel(String model) { this.model = model; }
  public String getRatio() { return ratio; }
  public void setRatio(String ratio) { this.ratio = ratio; }
  public String getSize() { return size; }
  public void setSize(String size) { this.size = size; }
  public String getQuality() { return quality; }
  public void setQuality(String quality) { this.quality = quality; }
  public String getOutput_format() { return output_format; }
  public void setOutput_format(String output_format) { this.output_format = output_format; }
  public String getBackground() { return background; }
  public void setBackground(String background) { this.background = background; }
  public Integer getRefs() { return refs; }
  public void setRefs(Integer refs) { this.refs = refs; }
  public String getResponse_mode() { return response_mode; }
  public void setResponse_mode(String response_mode) { this.response_mode = response_mode; }
}
