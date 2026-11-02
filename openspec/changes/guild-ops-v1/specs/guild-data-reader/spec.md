## ADDED Requirements

### Requirement: Parse Guild OS saved data
A reader on the GM's Windows PC SHALL parse the Guild OS addon's SavedVariables file into a normalized snapshot of guild roster, raid attendance, loot awards, wishlists and recruiting activity, for the addon version it was built against.

#### Scenario: Known addon version
- **WHEN** the file was written by a supported addon version
- **THEN** the reader produces a snapshot with every section the file contains

#### Scenario: Unknown shape
- **WHEN** a section's structure does not match the supported version
- **THEN** the reader fails that upload with a named error rather than sending a partial or guessed snapshot

### Requirement: Upload on change
The reader SHALL watch the file and upload a snapshot to an authenticated bot endpoint whenever the file changes, and SHALL retry with backoff when the upload fails.

#### Scenario: GM logs out after a raid
- **WHEN** the game writes the file on logout
- **THEN** a snapshot reaches the bot within a minute

#### Scenario: Bot unreachable
- **WHEN** the upload fails
- **THEN** the reader keeps the snapshot and retries, and reports the failure in its log and tray status

### Requirement: Idempotent ingestion
The bot SHALL ingest snapshots idempotently: uploading the same snapshot twice SHALL change nothing, and an older snapshot SHALL never overwrite newer data.

#### Scenario: Snapshot uploaded twice
- **WHEN** the same snapshot arrives twice
- **THEN** stored attendance and loot are unchanged by the second upload
