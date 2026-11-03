terraform {
  required_version = ">= 1.15.0"
  backend "s3" {
    bucket       = "wow-forever-tfstate-414700437904"
    key          = "base/terraform.tfstate"
    region       = "us-east-1"
    profile      = "aidb-personal"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
}
