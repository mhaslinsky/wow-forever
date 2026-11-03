# Base infrastructure

Uses the personal AWS account in us-east-1 with profile `aidb-personal`.

Run `npm ci` and `npm run build:alarm-forwarder` at the repository root before planning the main stack. TypeScript emits `build/alarm-forwarder/index.mjs`; Terraform archives that directory for the Node 22 Lambda. The Lambda runtime supplies `@aws-sdk/client-ssm`.

Bootstrap in `infra/bootstrap/` creates the encrypted, versioned state bucket with public access blocked. Its state stays local and must be kept safe outside git. Create the bucket through a separately reviewed plan before initializing the main stack's S3 backend. The main stack uses native S3 locking.

The three SecureString parameters start as `None`. Set their real values out of band in SSM after provisioning. Terraform ignores value changes. The forwarder reads its webhook at invocation time and fails if it is unset or delivery fails.

The monthly budget covers the whole account and sends actual-spend notifications at 80 and 100 percent of the configured amount (default $25). Budget data can be delayed. Discord is the only notification destination configured here; webhook failure has no independent alert path.

Not yet applied. AWS planning and deployment require a separate review; local validation does not establish AWS permissions or live delivery.
