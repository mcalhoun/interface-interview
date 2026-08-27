# Selection matches by token subset against a discovered set

Choosing among items on a screen is a generic action. It matches a parameter against item labels by token subset, over a set of legal values read off the page during Discovery. The model infers the mapping from a Goal's wording to a concrete label once, and we record it. It never gets written into source.

## Consequences

Matching is deterministic. The same list and the same parameter give the same choice every time. Determinism means no model in the loop, not no logic, which is a distinction worth stating out loud because it is easy to over-read. Token subset also tolerates label variation, so most Tenant differences are absorbed with no Override at all, and multi-tenant reuse falls out of the matching design instead of being bolted on. A Target matching two or more items is a Hard Failure, never a coin flip.
