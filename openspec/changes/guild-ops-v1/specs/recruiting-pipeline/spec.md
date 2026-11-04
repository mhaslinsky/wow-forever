## ADDED Requirements

### Requirement: One officer-only recruiting channel
Every candidate SHALL appear as exactly one thread in a single officer-only forum channel, whatever the source, and no other place SHALL be needed to see all candidates.

#### Scenario: Candidate from any source
- **WHEN** a candidate arrives from a Guilds of WoW application, `/apply`, `/lead` or an in-game recruit
- **THEN** one thread exists for that candidate in the recruiting channel, labeled with its source

### Requirement: Intake sources
The system SHALL create candidates from Guilds of WoW applications polled from its Management API, from an `/apply` form in Discord, from an officer `/lead` command, and from recruits recorded by the in-game addon.

#### Scenario: Unreadable application
- **WHEN** a Guilds of WoW application cannot be read
- **THEN** its raw JSON is kept, no thread is created, and an alarm posts to the officers' alert channel

#### Scenario: Officer adds a lead
- **WHEN** an officer runs `/lead` with a character name, class and where they were found
- **THEN** a New candidate thread is created with that officer as owner

### Requirement: Deduplication
Candidates SHALL be merged when they share a Discord account or a character name and realm-free Forever name.

#### Scenario: Same person applies twice
- **WHEN** a candidate with an existing thread applies again through another source
- **THEN** the new details are added to the existing thread and no second thread is created

### Requirement: Stages as tags
A candidate's stage SHALL be one of New, Contacted, Applied, Interview, Trial, Accepted, Declined or Withdrawn, shown as the thread's forum tag, and changing the tag SHALL change the stage.

#### Scenario: Officer moves the tag
- **WHEN** an officer changes a thread's tag from Interview to Trial
- **THEN** the candidate's stage becomes Trial and the change is recorded with who made it

### Requirement: Overdue digest
Each candidate SHALL carry an owner and a next-action date, and a daily digest in the officers' channel SHALL list candidates whose next action is overdue.

#### Scenario: Nothing overdue
- **WHEN** no candidate is overdue
- **THEN** the digest says so in one line rather than being skipped

### Requirement: Recruit data retention
Declined and Withdrawn candidates' officer notes SHALL be deleted after a configured retention period, leaving only the name and outcome.

#### Scenario: Retention elapses
- **WHEN** a Declined candidate passes the retention period
- **THEN** their notes are removed and the thread is archived
