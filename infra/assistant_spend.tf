variable "assistant_monthly_limit_usd" {
  type     = number
  default  = null
  nullable = true
  validation {
    condition     = var.assistant_monthly_limit_usd == null ? true : var.assistant_monthly_limit_usd >= 0
    error_message = "Assistant monthly limit must be nonnegative or unset."
  }
}

variable "assistant_input_per_million_usd" {
  type    = number
  default = 3
  validation {
    condition     = var.assistant_input_per_million_usd >= 0
    error_message = "Input token rate must be nonnegative."
  }
}

variable "assistant_output_per_million_usd" {
  type    = number
  default = 15
  validation {
    condition     = var.assistant_output_per_million_usd >= 0
    error_message = "Output token rate must be nonnegative."
  }
}

variable "assistant_search_usd" {
  type    = number
  default = 0.001
  validation {
    condition     = var.assistant_search_usd >= 0
    error_message = "Search rate must be nonnegative."
  }
}

locals {
  assistant_spend_environment = merge({
    ASSISTANT_INPUT_PER_MILLION_USD  = tostring(var.assistant_input_per_million_usd)
    ASSISTANT_OUTPUT_PER_MILLION_USD = tostring(var.assistant_output_per_million_usd)
    ASSISTANT_SEARCH_USD             = tostring(var.assistant_search_usd)
    }, var.assistant_monthly_limit_usd == null ? {} : {
    ASSISTANT_MONTHLY_LIMIT_USD = tostring(var.assistant_monthly_limit_usd)
  })
}
