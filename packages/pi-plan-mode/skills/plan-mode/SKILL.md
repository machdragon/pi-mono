---
name: plan-mode
description: Structured planning mode for complex tasks. Restricts tools to read-only, guides you through exploring the codebase, and writes an execution-ready plan file before making changes. Use when starting non-trivial implementation work.
---

# Plan Mode

Use this skill when you need to plan a non-trivial implementation before writing code. Plan mode restricts you to read-only tools (plus writing to the plan file) and guides you through a structured workflow.

## When To Use

- New features with architectural decisions or multiple valid approaches
- Multi-file changes where the wrong approach causes meaningful rework
- Unclear requirements that need exploration and user clarification
- The user explicitly requests `/plan` or `/plan long`

Do NOT use for: single-line fixes, obvious bug fixes, tasks with clear specific instructions.

## Commands

- `/plan [name]` - Enter plan mode with an optional plan name
- `/plan long [name]` - Enter interview-first planning for large/ambiguous tasks
- `/plan execute` - Start executing the plan with progress tracking
- `/plan exit` - Leave plan mode and restore full tool access
- `/plan status` - Show current plan state and progress
- `Ctrl+Alt+P` - Toggle plan mode on/off

## Workflow

### Standard (`/plan`)

1. **Explore** - Read code to understand existing patterns and architecture
2. **Design** - Form a recommended approach (facts vs proposals)
3. **Write** - Write the plan to the plan file incrementally
4. **Review** - Interactive prompt to execute, refine, or stay in plan mode

### Interview (`/plan long`)

For large or ambiguous projects:
1. Scan key files for initial understanding
2. Write a skeleton plan
3. Ask the user targeted questions
4. Iterate until the plan covers what/where/how/verify

## Plan File Format

Plans are saved to `.pi/plans/plan-{name}.md` with these sections:

- **Context** - Why this change is being made (1-2 sentences)
- **Approach** - Recommended implementation only
- **Files to Modify** - Paths with one-line descriptions
- **Reuse** - Existing functions/utilities with file paths
- **Verification** - Command(s) to confirm correctness

## Execution Tracking

After choosing "Execute", the extension tracks progress:
- Todo items are extracted from the plan file
- Mark steps complete with `[DONE:n]` in your response
- Progress shown in status bar and widget
