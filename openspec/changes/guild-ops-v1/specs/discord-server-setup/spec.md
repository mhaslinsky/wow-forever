## ADDED Requirements

### Requirement: Declarative server layout
The repository SHALL hold a layout file describing categories, channels, roles, role order and permission overwrites, and a tool SHALL compare it with the live server and print the differences before any change is applied.

#### Scenario: Plan shows differences
- **WHEN** the operator runs the plan against the live server
- **THEN** it lists every channel, role and overwrite that would be created, changed or removed, and changes nothing

#### Scenario: Apply twice
- **WHEN** the layout is applied and then applied again unchanged
- **THEN** the second apply makes no changes

### Requirement: Permission readback
After an apply, the tool SHALL read back every channel's effective permissions for each role and report any that differ from the layout.

#### Scenario: Private channel exposed
- **WHEN** an officer-only channel is readable by the Member role after an apply
- **THEN** the readback reports it as a failure

### Requirement: Operator agent identity
Server administration by an agent SHALL use a separate Discord application from the guild bot, driven only during sessions the operator supervises, with its token kept on the operator's machine and the MCP server restricted to the guild's server.

#### Scenario: Guild bot token cannot administer
- **WHEN** the guild bot's own token is used to delete a channel or edit roles above Officer
- **THEN** Discord rejects the action

### Requirement: Native safety and onboarding
The server SHALL use Discord AutoMod rules and Onboarding questions for interest and ping roles, and self-selected roles SHALL never grant Member, Raider or Officer.

#### Scenario: New arrival picks roles
- **WHEN** a newcomer completes Onboarding
- **THEN** they receive only the interest and ping roles they chose

### Requirement: News feeds
The server SHALL carry Forever news through webhooks into a news channel, with an opt-in ping role.

#### Scenario: Blizzard posts Forever news
- **WHEN** a configured news source publishes a Forever item
- **THEN** it appears in the news channel without manual action
