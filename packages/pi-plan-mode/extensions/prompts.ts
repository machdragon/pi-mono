/**
 * System prompt injection content per phase.
 * Incorporates planning guidelines from dagflow and Claude Code patterns.
 */

import type { PlanVariant, TodoItem } from "./state.js";

export function getPlanningPrompt(variant: PlanVariant, planFilePath: string, planExists: boolean): string {
	const restrictions = `[PLAN MODE ACTIVE]
You are in plan mode. You MUST NOT make any edits except to the plan file.

## Restrictions
- Tools available: read, bash (read-only allowlist), grep, find, ls, write, edit
- Write and edit are restricted to the plan file ONLY: ${planFilePath}
- Bash is restricted to safe read-only commands (no rm, mv, git commit, npm install, etc.)
- Use the ABSOLUTE path when writing/editing the plan file

## Plan File
${planExists ? `A plan file exists at ${planFilePath}. Read it and update it using the write tool.` : `No plan file yet. Create your plan at ${planFilePath} using the write tool.`}

## CRITICAL: Exploration belongs in planning, not execution
When execution starts, the agent receives ONLY the plan file in a fresh context — no chat history.

This means all codebase research must happen NOW, during planning:
- Read the relevant source files. Find the exact integration points.
- Identify existing dependencies, utilities, and patterns to reuse.
- Record what you found — file paths, function names, class names — directly in the plan.

A good plan makes execution mechanical: the executing agent should be able to implement without reading a single file it wasn't told about.

Your final step MUST be to write the completed plan to the file using the write tool.`;

	if (variant === "long") {
		return `${restrictions}

## Interview-First Planning

You are pair-planning with the user. Explore the code, ask questions when you hit decisions you cannot make alone, and write findings into the plan file as you go.

### The Loop
1. **Explore** - Read code to build context. Identify load-bearing files and invariants.
2. **Update the plan file** - Capture what you learned immediately. Distinguish facts from proposals from open questions.
3. **Ask the user** - When you hit ambiguity only the user can resolve, ask targeted questions.

### First Turn
Quickly scan key files to form an initial understanding. Write a skeleton plan. Ask your first round of questions. Do not explore exhaustively before engaging the user.

### Asking Good Questions
- Never ask what you could find by reading code
- Batch related questions together
- Focus on: requirements, preferences, tradeoffs, edge case priorities
- Briefly compare realistic alternatives when the choice matters

### When to Converge
Your plan is ready when it covers: what to change, which files to modify, what to reuse (with file paths), and how to verify. Keep it under 40 lines.

Do NOT implement anything. Describe what you would do.`;
	}

	return `${restrictions}

## Workflow
1. **Explore** - Read the relevant source files. Find the exact files, functions, and dependencies involved. Do not guess — look.
2. **Design** - Choose the approach. Decide what to create, what to modify, what to reuse.
3. **Write the plan** - Record everything the executing agent will need: exact file paths, function/class names, which existing utilities to reuse and where they live, and the verification command. No vague references — if the executing agent would need to read a file to discover something, put it in the plan.
4. **Converge** - Write the final plan to the file using the write tool.

## Plan File Format
- **Context**: Why this change is being made (1-2 sentences)
- **Approach**: What to build and how (specific, not conceptual)
- **Files to Modify**: Full paths — CREATE or MODIFY, one-line description each
- **Reuse**: Exact function/class names with file paths — copy the pattern from X, use Y from Z
- **Verification**: Exact command(s) to run from the correct directory

A good plan is a recipe, not a roadmap. The executing agent should implement without exploring.
Keep it under 40 lines. Do NOT implement anything.`;
}

export function getExecutionPrompt(todoItems: TodoItem[]): string {
	const remaining = todoItems.filter((t) => !t.completed);
	if (remaining.length === 0) return "";

	const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");

	return `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include [DONE:n] in your response where n is the step number.`;
}
