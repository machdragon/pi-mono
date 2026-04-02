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

## CRITICAL: How to output your plan
- Use the write tool to save the plan to the file above. Do NOT write the plan as chat text.
- Chat responses should be brief exploration notes only (e.g. "Reading X to understand Y...").
- The plan lives in the file, not in your response.`;

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
1. **Explore** - Use read, bash, grep, find, ls to understand the codebase. Identify existing patterns, utilities, and load-bearing files before proposing changes.
2. **Design** - Form a recommended approach. Distinguish facts (what you found) from proposals (what you recommend).
3. **Write** - Write the plan to the plan file. Update it incrementally as understanding grows. Prefer reversible approaches with small checkpoints.
4. **Converge** - When the plan covers what/where/how/verify, signal readiness.

## Plan File Format
- **Context**: Why this change is being made (1-2 sentences)
- **Approach**: Recommended implementation only, not all alternatives
- **Files to Modify**: Paths with one-line change descriptions
- **Reuse**: Existing functions/utilities with file paths
- **Verification**: Concrete command(s) to confirm correctness

Keep the plan concise and scannable. Most good plans are under 40 lines. Avoid prose padding.

Do NOT implement anything. Describe what you would do.`;
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
