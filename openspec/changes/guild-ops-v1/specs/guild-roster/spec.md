## ADDED Requirements

### Requirement: Roster from guild data
The roster SHALL link each Discord account to one or more characters, with class, spec, raid role and main or alt, built from accepted candidates, `/register`, and the latest in-game snapshot from the data reader.

#### Scenario: Recruit accepted
- **WHEN** an officer moves a candidate to Accepted
- **THEN** the bot DMs the candidate once that they are approved and should ask an officer for an in-game invite, creates a roster entry from the candidate's declared characters, and grants no Discord role

#### Scenario: Approval DM cannot be sent
- **WHEN** the accepted candidate has no linked Discord account or their DMs are closed
- **THEN** the candidate stays Accepted and the officers are alerted to contact them by hand

#### Scenario: Member role
- **WHEN** a candidate is accepted
- **THEN** they do not get the Member role until they are in the guild in-game and have proved which character is theirs

#### Scenario: Existing friend registers
- **WHEN** a member runs `/register` with their main and alts
- **THEN** a roster entry is created or updated, and characters also seen in the in-game snapshot are marked confirmed

### Requirement: Departures flagged
When a member leaves the Discord server, or disappears from the in-game guild roster in two consecutive snapshots, the bot SHALL flag them for an officer to confirm rather than deleting them.

#### Scenario: Member leaves Discord
- **WHEN** a rostered member leaves the server
- **THEN** a confirmation request posts to the officers' channel with Confirm and Keep buttons

### Requirement: Raid targets and needs board
Officers SHALL set target counts by role and class per raid team, defaulting to one 20-player team, and the bot SHALL keep a pinned needs board showing the gap between targets and the active roster.

#### Scenario: Healer joins
- **WHEN** a healer is added to the active roster of a team that was one healer short
- **THEN** the pinned needs board updates and no longer lists that healer gap

### Requirement: Recruiting message from needs
The bot SHALL produce a short recruiting message from the current needs board that officers can paste into the in-game addon.

#### Scenario: Needs change
- **WHEN** the needs board changes
- **THEN** `/needs message` returns text listing only the current gaps
