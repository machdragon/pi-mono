/**
 * Plan Mode Extension
 *
 * Structured planning mode for pi.dev with file-backed plans and execution tracking.
 *
 * Features:
 * - /plan [name] to enter plan mode, /plan long [name] for interview variant
 * - /plan execute, /plan exit, /plan status subcommands
 * - Ctrl+Alt+P shortcut to toggle
 * - Write and edit tools guarded to plan file only
 * - Bash restricted to safe read-only commands
 * - Todo extraction from plan file + [DONE:n] progress tracking
 * - Interactive review prompt (Execute / Refine / Stay)
 * - Session persistence for resume
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveToCwd } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

import { extractTodoItems, isSafeCommand, markCompletedSteps } from "./guards.js";
import { createPlanFile, planFileExists, readPlanFile } from "./plan-file.js";
import { getExecutionPrompt, getPlanningPrompt } from "./prompts.js";
import {
	createInitialState,
	deserializeState,
	serializeState,
	transition,
	type PlanState,
	type PlanVariant,
} from "./state.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "write", "edit"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let state: PlanState = createInitialState();

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// -- Helpers --

	function applyTransition(action: Parameters<typeof transition>[1]): void {
		state = transition(state, action);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode-state", serializeState(state));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.phase === "executing" && state.todoItems.length > 0) {
			const completed = state.todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan ${completed}/${state.todoItems.length}`));
		} else if (state.phase === "planning" || state.phase === "review") {
			const label = state.variant === "long" ? "plan:long" : "plan";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (state.phase === "executing" && state.todoItems.length > 0) {
			const lines = state.todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "done ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "todo ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else if (state.phase === "planning" && state.planFilePath) {
			ctx.ui.setWidget("plan-todos", [ctx.ui.theme.fg("muted", `plan: ${state.planFilePath}`)]);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function applyToolRestrictions(): void {
		if (state.phase === "planning" || state.phase === "review") {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
		}
	}

	function enterPlanMode(ctx: ExtensionContext, variant: PlanVariant, name?: string): void {
		const planFilePath = createPlanFile(ctx.cwd, name);
		applyTransition({ type: "enter", variant, planFilePath });
		applyToolRestrictions();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		applyTransition({ type: "exit" });
		applyToolRestrictions();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Plan mode disabled. Full access restored.");
	}

	// -- Commands --

	pi.registerCommand("plan", {
		description: "Plan mode: /plan [name], /plan long [name], /plan execute, /plan exit, /plan status",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() ?? "";

			switch (subcommand) {
				case "execute": {
					if (state.phase !== "planning" && state.phase !== "review") {
						ctx.ui.notify("Not in plan mode.", "warning");
						return;
					}
					const content = state.planFilePath ? readPlanFile(state.planFilePath) : null;
					if (content) {
						state.todoItems = extractTodoItems(content);
					}
					applyTransition({ type: "execute" });
					applyToolRestrictions();
					updateStatus(ctx);
					persistState();
					if (state.todoItems.length > 0) {
						pi.sendMessage(
							{
								customType: "plan-mode-execute",
								content: `Execute the plan. Start with: ${state.todoItems[0].text}`,
								display: true,
							},
							{ triggerTurn: true },
						);
					} else {
						pi.sendMessage(
							{
								customType: "plan-mode-execute",
								content: "Execute the plan you just created.",
								display: true,
							},
							{ triggerTurn: true },
						);
					}
					return;
				}

				case "exit": {
					exitPlanMode(ctx);
					return;
				}

				case "status": {
					if (state.phase === "idle") {
						ctx.ui.notify("Plan mode is not active.", "info");
						return;
					}
					let msg = `Phase: ${state.phase}, Variant: ${state.variant}`;
					if (state.planFilePath) msg += `\nPlan: ${state.planFilePath}`;
					if (state.todoItems.length > 0) {
						const completed = state.todoItems.filter((t) => t.completed).length;
						msg += `\nProgress: ${completed}/${state.todoItems.length}`;
						const list = state.todoItems
							.map((t) => `${t.step}. ${t.completed ? "[x]" : "[ ]"} ${t.text}`)
							.join("\n");
						msg += `\n${list}`;
					}
					ctx.ui.notify(msg, "info");
					return;
				}

				case "long": {
					if (state.phase !== "idle") {
						ctx.ui.notify("Already in plan mode. Use /plan exit first.", "warning");
						return;
					}
					const name = parts.slice(1).join("-") || undefined;
					enterPlanMode(ctx, "long", name);
					return;
				}

				default: {
					if (state.phase === "idle") {
						const name = args.trim() || undefined;
						enterPlanMode(ctx, "standard", name);
					} else {
						exitPlanMode(ctx);
					}
				}
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (state.phase === "idle") {
				enterPlanMode(ctx, "standard");
			} else {
				exitPlanMode(ctx);
			}
		},
	});

	// -- Event Handlers --

	// Block destructive bash + guard write/edit to plan file only
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase !== "planning" && state.phase !== "review") return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = event.input.path as string | undefined;
			if (!rawPath || !state.planFilePath) {
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is restricted to the plan file only.\nAllowed: ${state.planFilePath}\nAttempted: ${rawPath ?? "(no path)"}`,
				};
			}
			// Resolve ~ and relative paths before comparing
			const resolved = resolveToCwd(rawPath, ctx.cwd);
			if (resolved !== state.planFilePath) {
				return {
					block: true,
					reason: `Plan mode: ${event.toolName} is restricted to the plan file only.\nAllowed: ${state.planFilePath}\nAttempted: ${resolved}`,
				};
			}
			return;
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not in safe allowlist). Use /plan exit to disable plan mode first.\nCommand: ${command}`,
				};
			}
		}
	});

	// Filter stale plan-mode context messages when not in plan mode
	pi.on("context", async (event) => {
		if (state.phase !== "idle") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.customType === "plan-execution-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject phase-appropriate system prompt
	pi.on("before_agent_start", async () => {
		if (state.phase === "planning" || state.phase === "review") {
			const planExists = state.planFilePath ? planFileExists(state.planFilePath) : false;
			return {
				message: {
					customType: "plan-mode-context",
					content: getPlanningPrompt(state.variant, state.planFilePath ?? "", planExists),
					display: false,
				},
			};
		}

		if (state.phase === "executing" && state.todoItems.length > 0) {
			const prompt = getExecutionPrompt(state.todoItems);
			if (prompt) {
				return {
					message: {
						customType: "plan-execution-context",
						content: prompt,
						display: false,
					},
				};
			}
		}
	});

	// Track [DONE:n] progress during execution
	pi.on("turn_end", async (event, ctx) => {
		if (state.phase !== "executing" || state.todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, state.todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and review flow
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (state.phase === "executing" && state.todoItems.length > 0) {
			if (state.todoItems.every((t) => t.completed)) {
				const completedList = state.todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!**\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				applyTransition({ type: "finish" });
				applyToolRestrictions();
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		// In planning phase: read plan file, extract todos, prompt for review
		if (state.phase !== "planning" || !ctx.hasUI) return;

		if (state.planFilePath) {
			const content = readPlanFile(state.planFilePath);
			if (content) {
				const extracted = extractTodoItems(content);
				if (extracted.length > 0) {
					state.todoItems = extracted;
				}
			}
		}

		applyTransition({ type: "ready-for-review" });
		persistState();

		if (state.todoItems.length > 0) {
			const todoListText = state.todoItems.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${state.todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - what next?", [
			state.todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Refine the plan",
			"Stay in plan mode",
		]);

		if (choice?.startsWith("Execute")) {
			applyTransition({ type: "execute" });
			applyToolRestrictions();
			updateStatus(ctx);
			persistState();

			const execMessage =
				state.todoItems.length > 0
					? `Execute the plan. Start with: ${state.todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			applyTransition({ type: "refine" });
			updateStatus(ctx);
			persistState();

			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		} else {
			// Stay in plan mode (revert from review to planning)
			applyTransition({ type: "refine" });
			updateStatus(ctx);
			persistState();
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true && state.phase === "idle") {
			enterPlanMode(ctx, "standard");
			return;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const stateEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode-state")
			.pop() as { data?: unknown } | undefined;

		if (stateEntry?.data) {
			const restored = deserializeState(stateEntry.data);
			if (restored) {
				state = restored;

				// Verify plan file still exists
				if (state.planFilePath && !planFileExists(state.planFilePath)) {
					state = createInitialState();
				}
			}
		}

		// On resume in executing phase: re-scan messages for [DONE:n] completion
		if (state.phase === "executing" && state.todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, state.todoItems);
		}

		applyToolRestrictions();
		updateStatus(ctx);
	});
}
