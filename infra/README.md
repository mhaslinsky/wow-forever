# Base infrastructure

Uses the personal AWS account in us-east-1 with profile `aidb-personal`.

Run `npm ci` and `npm run build:alarm-forwarder` at the repository root before planning the main stack. esbuild bundles the handler and its SDK dependencies into `build/alarm-forwarder/index.mjs`; Terraform archives that directory for the Node 22 Lambda. A `createRequire` shim supports the bundled SDK's Node built-in imports. The artifact includes `@aws-sdk/client-ssm`; it does not rely on runtime module lookup.

Bootstrap in `infra/bootstrap/` creates the encrypted, versioned state bucket with public access blocked. Use this two-step procedure:

1. In `infra/bootstrap/`, run `terraform init`, then have the orchestrator review and apply the initial local-state plan. Keep that state safe outside the worktree until migration succeeds.
2. After the bucket exists, uncomment the `backend "s3"` block in `infra/bootstrap/main.tf` and run `terraform init -migrate-state` from `infra/bootstrap/`. Confirm migration to `bootstrap/terraform.tfstate` before removing the local copy. Then initialize the main stack's backend.

The bucket requires TLS, enforces bucket ownership, and expires noncurrent state versions after 90 days. The main stack uses native S3 locking.

The three SecureString parameters start as `None`. Set their real values out of band in SSM after provisioning. Terraform uses write-only `value_wo` with version 1, so parameter values are not retained in state. Leave the version unchanged when rotating secrets out of band. The forwarder reads its webhook at invocation time and fails if it is unset or delivery fails.

The monthly budget covers the whole account and sends actual-spend notifications at 80 and 100 percent of the configured amount (default $25). Budget data can be delayed. Discord is the only notification destination configured here; webhook failure has no independent alert path.

Not yet applied. AWS planning and deployment require a separate review; local validation does not establish AWS permissions or live delivery.
