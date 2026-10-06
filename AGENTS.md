# Code guidelines

Prefer code a developer unfamiliar with Next.js can follow. Optimize for clarity,
not the fewest lines or the most abstractions.

## Readability

- Use descriptive names for domain concepts, state, and parser nodes.
- Expand conditionals, error handling, and object construction across lines when
  they contain multiple actions or fields. Avoid compressed one-line branches.
- Keep functions focused on one responsibility. Extract meaningful operations
  when they make the calling code easier to understand; avoid trivial wrappers.
- Keep the main workflow visible in orchestration functions.
- Comment on reasons, constraints, and surprising behavior, rather than restating
  the code. Document units and ownership for deadlines, limits, and mutable state.
- Prefer explicit control flow over nested ternaries and clever expressions.

## Architecture and types

- Think about bounded contexts in code
- Keep architecture thoughtful and based in the good practices
- Keep UI rendering, application workflows, and external integrations separate.
- Pass dependencies explicitly. Function factories and classes are both valid;
  use whichever expresses the responsibility most clearly.
- Introduce interfaces and abstractions for real boundaries, not every helper.
- Use clean separation of concerns 
- Validate external input at runtime. TypeScript annotations do not validate data.
- Avoid `any` and unchecked assertions. Narrow `unknown` near the input boundary.
- Prefer named types when an inline type becomes difficult to read or is reused.

## Next.js and React

- Keep secrets and infrastructure access in server modules with `server-only`.
- Keep HTTP handlers thin: validate input, call the application service, and map
  its result to a response.
- Use Client Components for interaction. Access browser APIs in effects or event
  handlers, rather than assuming rendering always happens in the browser.
- Use functional state updates when the next value depends on previous state.
- Keep rendering free of side effects. Keep hooks focused on related behavior.

## Changes and verification

- Follow nearby conventions unless they obscure the code; do not copy dense style.
- Keep changes focused. Do not add frameworks or speculative extension points.
- Test meaningful behavior and failure cases, rather than internal implementation.
- Run checks appropriate to the change. Documentation-only edits need no tests.
