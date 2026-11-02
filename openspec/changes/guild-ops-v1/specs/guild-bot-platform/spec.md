## ADDED Requirements

### Requirement: Verified interactions endpoint
The bot SHALL accept Discord interactions only through an HTTPS endpoint that verifies the Ed25519 signature and timestamp on every request and rejects any request that fails verification.

#### Scenario: Valid signature
- **WHEN** Discord sends an interaction with a valid signature
- **THEN** the endpoint processes it and responds within Discord's three-second window, deferring when work takes longer

#### Scenario: Invalid signature
- **WHEN** a request arrives with a missing or invalid signature
- **THEN** the endpoint responds 401 and performs no work

### Requirement: Deferred work never hangs
Any interaction whose work outlasts the initial response SHALL be deferred, completed by an asynchronous worker with automatic retries disabled, and the deferred reply SHALL be edited with a result or an error before the worker's time limit.

#### Scenario: Worker near its time limit
- **WHEN** a worker has not finished a few seconds before its time limit
- **THEN** it edits the deferred reply to say the request timed out and stops

### Requirement: Always-connected client
The system SHALL run one always-connected Discord client that receives message, member and voice-state events and writes to the same store as the interactions endpoint, and it SHALL reconnect and resume after a dropped connection.

#### Scenario: Connection dropped
- **WHEN** the gateway connection drops
- **THEN** the client reconnects, resumes the session where possible, and records the gap in its log

#### Scenario: Client down
- **WHEN** the client has sent no heartbeat for ten minutes
- **THEN** an alarm posts to the officers' alert channel

### Requirement: Role-based data boundary
Every data read SHALL take the asker's Discord roles and return only records that role may see. Candidate records, officer notes, loot-council votes and reasons SHALL be visible only to officers.

#### Scenario: Member asks about a candidate
- **WHEN** a member without the Officer role requests any candidate or officer-only record, directly or through the assistant
- **THEN** the system returns no officer-only data and does not pass it to a model

### Requirement: Secrets and alarms
Tokens and keys SHALL be stored only in the secret store, never in the repository, and the stack SHALL have a billing alarm and an alarm topic forwarded to the officers' alert channel.

#### Scenario: Monthly spend threshold crossed
- **WHEN** estimated monthly AWS charges cross the configured threshold
- **THEN** an alert posts to the officers' alert channel
