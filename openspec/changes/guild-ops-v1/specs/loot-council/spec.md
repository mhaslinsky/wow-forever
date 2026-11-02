## ADDED Requirements

### Requirement: Wishlists
Members SHALL set a ranked wishlist with `/wishlist`, and wishlists SHALL lock a configured time before each raid.

#### Scenario: Edit after lock
- **WHEN** a member edits their wishlist after the lock time
- **THEN** the change is saved for the next raid and the current raid uses the locked list

### Requirement: Council vote in Discord
An officer SHALL start a vote with `/lc item <name>`, and the bot SHALL post in the loot-council channel each contender's wishlist rank, attendance rate, loot received recently and raid role, with vote buttons for each officer.

#### Scenario: Vote posted
- **WHEN** an officer runs `/lc item` for an item two members wishlisted
- **THEN** both appear with their evidence and each officer can cast one vote, which they may change until the vote closes

### Requirement: Decision log
Closing a vote SHALL record the winner, the votes, the deciding officer and a required reason, visible only to officers.

#### Scenario: Close without reason
- **WHEN** an officer tries to close a vote without a reason
- **THEN** the bot refuses until a reason is given

### Requirement: Award confirmed from game data
When an ingested snapshot shows the item awarded in game, the bot SHALL mark the decision confirmed, and SHALL flag a mismatch if the item went to someone else.

#### Scenario: Awarded to a different player
- **WHEN** the snapshot shows the item awarded to someone other than the logged winner
- **THEN** the officers' channel receives a mismatch alert
