# Role ordering

PER-345 replaces the fixed role-slot allocator after the live gate refused an operator already at the top. This builds on the existing Discord transport and role comparator. discord.js exposes role position writes but does not allocate layout ranks or check a plan before its other writes.

The position fixtures in `test/fixtures/role-ordering.json` were extracted from 40 Discord API requests on Nov 3. They retain role IDs and request bodies, with positions and role metadata selected from the responses. The original request and response files stay in the operator's gate logs.

Creation returns position 1 without shifting existing roles. A reorder replaces requested numbers, resolves ties with older IDs higher, and compacts every role. An equal-operator target succeeds; an above-operator target returns 50013. Deletion can leave gaps. An empty reorder compacts the list without changing its relative order.

Layout roles retain their existing bottom-to-top order. Execution refetches after creates, sorts every role below the operator, and substitutes the managed roles into their ranks in layout order. Unmanaged roles retain their ranks and relative order. The request assigns distinct positions from 1 through the number of roles below the operator.

When those ranks reach the operator's stored position, execution first sends an empty reorder and refetches. This avoids collisions between new rank targets and the operator's old number. The final request never targets the operator or a role above it. The plan refuses an edit above the operator or an order that crosses its boundary, before apply mutates anything. An unchanged role above the operator can stay in place. Low stored numbers alone do not cause refusal.

Tests replay the captured requests against the shared model, including 50013 and empty compaction. Executor tests cover two new roles, refusal before mutations, unmanaged rank preservation, and the gate's step-2 layout with an empty second plan and zero-mutation second apply.

Test contract corrected because: position 1 alone does not make an older operator uneditable relative to newly created roles. The refusal case now has an existing role above the operator. Unmanaged numeric positions may change during compaction, so the convergence test expects the retained rank. The creation guard applies to private channels; the gate also creates public channels.
