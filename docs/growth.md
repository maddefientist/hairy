# Growth Engine

Growth components live in `packages/growth`.

## Components
- `SkillRegistry`: manages skill lifecycle (`draft -> testing -> candidate -> promoted -> archived`)
- `PromptVersionManager`: stores prompt versions with hashes and rollback
- `EvalHarness`: records score trends
- `InitiativeEngine`: stores proactivity rules and runtime state

## Reflection
`packages/memory/src/reflection.ts` stores run reflections into semantic memory.

## Suggested workflow
1. Add draft skill
2. Run shadow/testing mode
3. Promote on stable score improvements
4. Archive obsolete behaviors
