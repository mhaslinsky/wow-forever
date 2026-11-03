# Base infrastructure

Uses the personal AWS account in us-east-1 with profile `aidb-personal`.

Run `npm ci` and `npm run build:alarm-forwarder` at the repository root before planning the main stack. esbuild bundles the handler and its SDK dependencies into `build/alarm-forwarder/index.mjs`; Terraform archives that directory for the Node 22 Lambda. A `createRequire` shim supports the bundled SDK's Node built-in imports. The artifact includes `@aws-sdk/client-ssm`; it does not rely on runtime module lookup.

Bootstrap in `infra/bootstrap/` creates the encrypted, versioned state bucket with public access blocked. Use this two-step procedure:

Bootstrap state lives in the bucket it creates (`bootstrap/terraform.tfstate`). On a fresh account the bucket does not exist yet, so:

1. Comment out the `backend "s3"` block in `infra/bootstrap/main.tf`, run `terraform init`, review the plan and apply it with local state.
2. Restore the block and run `terraform init -migrate-state`. Confirm the state object exists in the bucket before deleting the local state files. Then initialize the main stack's backend.

The bucket requires TLS, enforces bucket ownership, and expires noncurrent state versions after 90 days. The main stack uses native S3 locking.

The three SecureString parameters start as `None`. Set their real values out of band in SSM after provisioning. Terraform uses write-only `value_wo` with version 1, so parameter values are not retained in state. Leave the version unchanged when rotating secrets out of band. The forwarder reads its webhook at invocation time and fails if it is unset or delivery fails.

The monthly budget covers the whole account and sends actual-spend notifications at 80 and 100 percent of the configured amount (default $25). Budget data can be delayed. Budget alerts also go straight to the operator's email, so they arrive even when the Discord webhook is unset or failing. Other alarms on the topic reach Discord only.

Applied on 2026-11-03 in account 414700437904. A test invoke loaded the bundle, read the placeholder through SSM and KMS, and failed with "Webhook not configured", which is the expected result until the webhook value is set.

## Rollback

Deletion protection blocks `terraform destroy` for the DynamoDB table. Removal takes two applies: set `deletion_protection_enabled = false` and apply, then remove the table resource and apply again. Point-in-time recovery (PITR) retains 35 days of restore points.
