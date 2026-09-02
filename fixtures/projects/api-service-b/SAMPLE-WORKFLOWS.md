# API sample task recipes

Use one recipe unchanged when creating a Loomrail Task. Both recipes target the shipped
Discovery → Plan → Implement → Review → QA → Acceptance workflow. They do not execute automatically.

## Recipe 1 — Filter issues by severity

**Title**

```text
Add an exact severity filter to issue listing
```

**Brief**

```text
Allow GET /issues to filter the returned issues by exact low or high severity while preserving the unfiltered default.
Keep the handler pure, never mutate the seed data, add no dependencies or network I/O, and add focused tests for both
accepted values and unknown input.
```

**Acceptance criteria**

```text
No severity query returns both issues in their existing order.
low and high each return only the matching issue; an unknown value returns a typed INVALID_SEVERITY result.
Repeated calls do not mutate seed data and all tests pass with node --test.
```

## Recipe 2 — Validate issue creation

**Title**

```text
Validate the create-issue request contract
```

**Brief**

```text
Add a pure POST /issues branch that accepts a title and low or high severity. Return a typed HTTP-style result, reject
unknown fields and invalid values, and do not persist or mutate the seed collection. Add no dependencies or network
I/O and cover success and each refusal with focused tests.
```

**Acceptance criteria**

```text
A valid payload returns status 201 with a normalized issue value.
Blank title, unsupported severity and unknown fields return status 400 with stable machine-readable error codes.
GET /issues remains unchanged after create calls and all tests pass with node --test.
```
