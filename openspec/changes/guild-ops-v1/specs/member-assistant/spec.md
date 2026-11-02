## ADDED Requirements

### Requirement: Members only
The assistant SHALL answer only users with the Member role, through `/ask` or an @-mention, and SHALL refuse everyone else without calling a model.

#### Scenario: Non-member asks
- **WHEN** a user without the Member role uses `/ask`
- **THEN** they get a short refusal and no model call is made

### Requirement: Grounded answers
The assistant SHALL draw guild facts (schedule, needs, rules, their own roster data) from guild records before using web search, SHALL search for game facts that patches can change, and SHALL say when it cannot verify a number rather than inventing one.

#### Scenario: Unverifiable ability number
- **WHEN** a member asks for a Forever ability value no source confirms
- **THEN** the answer says the value is not verified and links what it found

### Requirement: Consented memory
The assistant SHALL store a fact about a member only when the member asks it to remember it, and `/forget` SHALL delete all of that member's stored facts.

#### Scenario: Forget
- **WHEN** a member runs `/forget`
- **THEN** all their stored facts are deleted and later answers do not use them

### Requirement: Spend limits
Each member SHALL have a cooldown between questions, and a guild-wide monthly spend limit SHALL disable the assistant until the next month once reached, with a notice to officers.

#### Scenario: Monthly limit reached
- **WHEN** the month's assistant spend reaches the limit
- **THEN** further questions get a short "paused for the month" reply and no model call
