# Base infrastructure

Uses the personal AWS account in us-east-1 with profile `aidb-personal`.

Run `npm ci` and `npm run build:alarm-forwarder` at the repository root before planning the main stack. esbuild bundles the handler and its SDK dependencies into `build/alarm-forwarder/index.mjs`; Terraform archives that directory for the Node 22 Lambda. A `createRequire` shim supports the bundled SDK's Node built-in imports. The artifact includes `@aws-sdk/client-ssm`; it does not rely on runtime module lookup.

Bootstrap in `infra/bootstrap/` creates the encrypted, versioned state bucket with public access blocked. Use this two-step procedure:

Bootstrap state lives in the bucket it creates (`bootstrap/terraform.tfstate`). On a fresh account the bucket does not exist yet, so:

1. Comment out the `backend "s3"` block in `infra/bootstrap/main.tf`, run `terraform init`, review the plan and apply it with local state.
2. Restore the block and run `terraform init -migrate-state`. Confirm the state object exists in the bucket before deleting the local state files. Then initialize the main stack's backend.

The bucket requires TLS, enforces bucket ownership, and expires noncurrent state versions after 90 days. The main stack uses native S3 locking.

Terraform tracks seven SecureString parameters. The four secrets in `aws_ssm_parameter.secrets` (`discord_bot_token`, `discord_app_public_key`, `alarm_webhook_url`, and `reader_token`) start as `None`. Set their real values out of band in SSM after provisioning. Terraform uses write-only `value_wo` with version 1; leave the version unchanged when rotating secrets out of band. The forwarder reads its webhook at invocation time and fails if it is unset or delivery fails. Snapshot ingest returns 503 while the reader token is unset.

The three operator-managed API keys (`raid_helper_api_key`, `guildsofwow_api_key`, and `parallel_api_key`) must already exist in SSM. Native import blocks in `ssm.tf` import them into `aws_ssm_parameter.external_api_keys`; a missing key makes import fail instead of creating a placeholder parameter. Terraform 1.15.6 supports the import blocks' `for_each`. These resources use `ignore_changes = all` to prevent Terraform from updating their values or attributes. Rotate keys and change their attributes out of band. wow-orch reviews the post-import plan and applies only if it shows no PutParameter for these three parameters.

The API key resources also use `prevent_destroy = true`, which rejects plans that would destroy or replace them, including `terraform destroy`. Keep their resource definition in place: removing it also removes that protection. To stop tracking a key without deleting it, remove its import entry and remove its address from state before removing its resource instance.

The monthly budget covers the whole account and sends actual-spend notifications at 80 and 100 percent of the configured amount (default $25). Budget data can be delayed. Budget alerts also go straight to the operator's email, so they arrive even when the Discord webhook is unset or failing. Other alarms on the topic reach Discord only.

Applied on 2026-11-03 in account 414700437904. A test invoke loaded the bundle, read the placeholder through SSM and KMS, and failed with "Webhook not configured", which is the expected result until the webhook value is set.

## Rollback

Deletion protection blocks `terraform destroy` for the DynamoDB table. Removal takes two applies: set `deletion_protection_enabled = false` and apply, then remove the table resource and apply again. Point-in-time recovery (PITR) retains 35 days of restore points.
