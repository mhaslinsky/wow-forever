## ADDED Requirements

### Requirement: Sign-ups from Raid-Helper
The bot SHALL read each raid's sign-ups from Raid-Helper and store them as the raid's sign-up record, separate from attendance.

#### Scenario: Raid event updated
- **WHEN** a Raid-Helper event's sign-ups change before the raid
- **THEN** the stored sign-up record reflects the latest state within the polling interval

### Requirement: Measured attendance
A raid's attendance SHALL come from the in-game snapshot when it contains that raid, and otherwise from raid voice-channel presence recorded by the always-connected client, and the record SHALL say which source it used.

#### Scenario: Snapshot has the raid
- **WHEN** a snapshot containing the raid is ingested
- **THEN** attendance uses the snapshot and is marked as measured in game

#### Scenario: No snapshot yet
- **WHEN** no snapshot covers the raid
- **THEN** attendance uses voice presence and is marked as from voice

### Requirement: Said yes versus came
After each raid the bot SHALL post to the officers' channel who signed up and came, signed up and did not come, and came without signing up.

#### Scenario: No-show
- **WHEN** a member signed up as accepted but does not appear in attendance
- **THEN** they are listed as a no-show in the post-raid report
