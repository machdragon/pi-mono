import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";
import type { SlackBot } from "./slack.js";

export interface GoodMorningOptions {
	channelId: string;
	time: string;
	text: string;
}

export interface GoodMorningConfig extends GoodMorningOptions {
	schedule: string;
	timezone: string;
	stateFilePath: string;
}

interface GoodMorningState {
	lastSentOn?: string;
}

export class GoodMorningScheduler {
	private cron: Cron | null = null;

	constructor(
		private config: GoodMorningConfig,
		private slack: Pick<SlackBot, "postMessage" | "logBotResponse">,
	) {}

	start(): void {
		if (this.cron) return;

		this.cron = new Cron(this.config.schedule, { protect: true, timezone: this.config.timezone }, async () => {
			await this.trigger();
		});

		const nextRun = this.cron.nextRun();
		log.logInfo(
			`Good morning scheduler started for ${this.config.channelId} at ${this.config.time} ${this.config.timezone}, next run: ${nextRun?.toISOString() ?? "unknown"}`,
		);
	}

	stop(): void {
		if (!this.cron) return;
		this.cron.stop();
		this.cron = null;
		log.logInfo("Good morning scheduler stopped");
	}

	async trigger(now: Date = new Date()): Promise<boolean> {
		const today = getDateKeyInTimezone(now, this.config.timezone);
		const state = readGoodMorningState(this.config.stateFilePath);

		if (state.lastSentOn === today) {
			log.logInfo(`Skipping duplicate good morning for ${this.config.channelId} on ${today}`);
			return false;
		}

		const ts = await this.slack.postMessage(this.config.channelId, this.config.text);
		this.slack.logBotResponse(this.config.channelId, this.config.text, ts);
		writeGoodMorningState(this.config.stateFilePath, { lastSentOn: today });
		log.logInfo(`Posted good morning to ${this.config.channelId} on ${today}`);
		return true;
	}
}

export function resolveGoodMorningConfig(
	workspaceDir: string,
	options?: Partial<GoodMorningOptions>,
): GoodMorningConfig | null {
	const channelId = options?.channelId?.trim();
	if (!channelId) return null;

	const time = options?.time?.trim() || "08:00";
	const text = options?.text?.trim() || "Good morning";
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (!timezone) {
		throw new Error("Could not determine local timezone for good morning scheduler");
	}

	return {
		channelId,
		time,
		text,
		schedule: toDailyCronSchedule(time),
		timezone,
		stateFilePath: join(workspaceDir, ".good-morning-state.json"),
	};
}

export function createGoodMorningScheduler(
	config: GoodMorningConfig,
	slack: Pick<SlackBot, "postMessage" | "logBotResponse">,
): GoodMorningScheduler {
	return new GoodMorningScheduler(config, slack);
}

export function toDailyCronSchedule(time: string): string {
	const match = /^(\d{2}):(\d{2})$/.exec(time);
	if (!match) {
		throw new Error(`Invalid good morning time '${time}'. Expected HH:MM in 24-hour format.`);
	}

	const hour = Number.parseInt(match[1], 10);
	const minute = Number.parseInt(match[2], 10);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`Invalid good morning time '${time}'. Expected HH:MM in 24-hour format.`);
	}

	return `${minute} ${hour} * * *`;
}

export function getDateKeyInTimezone(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	const parts = formatter.formatToParts(date);
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const day = parts.find((part) => part.type === "day")?.value;
	if (!year || !month || !day) {
		throw new Error(`Could not format date for timezone ${timezone}`);
	}

	return `${year}-${month}-${day}`;
}

function readGoodMorningState(stateFilePath: string): GoodMorningState {
	if (!existsSync(stateFilePath)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(stateFilePath, "utf-8")) as GoodMorningState;
	} catch (error) {
		log.logWarning(`Failed to read good morning state: ${stateFilePath}`, String(error));
		return {};
	}
}

function writeGoodMorningState(stateFilePath: string, state: GoodMorningState): void {
	writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}
