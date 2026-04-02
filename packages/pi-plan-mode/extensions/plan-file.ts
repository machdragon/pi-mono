/**
 * Plan file I/O.
 * Plans are stored as markdown in {cwd}/.pi/plans/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLANS_DIR = ".pi/plans";

const PLAN_TEMPLATE = `## Context
<!-- Why this change is being made -->

## Approach
<!-- Recommended implementation -->

## Files to Modify
<!-- Paths and one-line descriptions -->

## Reuse
<!-- Existing functions/utilities with file paths -->

## Verification
<!-- Command(s) to confirm the change works -->
`;

export function getPlansDir(cwd: string): string {
	return join(cwd, PLANS_DIR);
}

export function createPlanFile(cwd: string, name?: string): string {
	const dir = getPlansDir(cwd);
	mkdirSync(dir, { recursive: true });

	const slug = name
		? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
		: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const filePath = join(dir, `plan-${slug}.md`);

	writeFileSync(filePath, PLAN_TEMPLATE, "utf-8");
	return filePath;
}

export function readPlanFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

export function writePlanFile(filePath: string, content: string): void {
	writeFileSync(filePath, content, "utf-8");
}

/** Returns true if the file still contains only the blank template (no real content). */
export function isPlanFileTemplate(content: string): boolean {
	return content.includes("<!-- Why this change") || content.includes("<!-- Recommended implementation");
}

export function planFileExists(filePath: string): boolean {
	return existsSync(filePath);
}
