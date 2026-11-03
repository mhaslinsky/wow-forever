provider "aws" {
  region              = "us-east-1"
  profile             = var.aws_profile
  allowed_account_ids = [var.aws_account_id]
  default_tags { tags = { project = "wow-forever" } }
}
variable "aws_profile" {
  type    = string
  default = "aidb-personal"
}
variable "aws_account_id" {
  type    = string
  default = "414700437904"
}
variable "monthly_budget_usd" {
  type    = number
  default = 25
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "Budget must be positive."
  }
}

variable "budget_alert_email" {
  type    = string
  default = "mhaslinsky@gmail.com"
}
