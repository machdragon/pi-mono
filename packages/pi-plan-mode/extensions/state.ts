/**
 * Plan mode state machine.
 * Pure reducer pattern — no side effects, fully testable.
 */

export type PlanPhase = "idle" | "planning" | "review" | "executing";
export type PlanVariant = "standard" | "long";

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export interface PlanState {
	phase: PlanPhase;
	variant: PlanVariant;
	planFilePath: string | null;
	todoItems: TodoItem[];
}

export type PlanAction =
	| { type: "enter"; variant: PlanVariant; planFilePath: string }
	| { type: "ready-for-review" }
	| { type: "refine" }
	| { type: "execute" }
	| { type: "complete-step"; step: number }
	| { type: "finish" }
	| { type: "exit" };

export function createInitialState(): PlanState {
	return { phase: "idle", variant: "standard", planFilePath: null, todoItems: [] };
}

export function transition(state: PlanState, action: PlanAction): PlanState {
	switch (action.type) {
		case "enter":
			return {
				phase: "planning",
				variant: action.variant,
				planFilePath: action.planFilePath,
				todoItems: [],
			};

		case "ready-for-review":
			if (state.phase !== "planning") return state;
			return { ...state, phase: "review" };

		case "refine":
			if (state.phase !== "review") return state;
			return { ...state, phase: "planning" };

		case "execute":
			if (state.phase !== "review" && state.phase !== "planning") return state;
			return { ...state, phase: "executing" };

		case "complete-step": {
			if (state.phase !== "executing") return state;
			const todoItems = state.todoItems.map((item) =>
				item.step === action.step ? { ...item, completed: true } : item,
			);
			return { ...state, todoItems };
		}

		case "finish":
			return createInitialState();

		case "exit":
			return createInitialState();
	}
}

export interface SerializedState {
	phase: PlanPhase;
	variant: PlanVariant;
	planFilePath: string | null;
	todoItems: TodoItem[];
}

export function serializeState(state: PlanState): SerializedState {
	return { ...state };
}

export function deserializeState(data: unknown): PlanState | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (!d.phase || typeof d.phase !== "string") return null;
	const validPhases: PlanPhase[] = ["idle", "planning", "review", "executing"];
	if (!validPhases.includes(d.phase as PlanPhase)) return null;
	return {
		phase: d.phase as PlanPhase,
		variant: (d.variant as PlanVariant) ?? "standard",
		planFilePath: typeof d.planFilePath === "string" ? d.planFilePath : null,
		todoItems: Array.isArray(d.todoItems) ? d.todoItems : [],
	};
}
