export interface DailySlackMessageOptions {
	webhookUrl: string;
	message?: string;
	scheduleTime?: string;
	timeZone?: string;
	enabled?: boolean;
	fetch?: typeof fetch;
	now?: () => Date;
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
	logger?: Pick<Console, "info" | "error">;
}

export interface DailySlackMessageStatus {
	enabled: boolean;
	message: string;
	scheduleTime: string;
	timeZone: string;
	nextRunAt?: Date;
	lastSentOn?: string;
}

export interface DailySlackMessageScheduler {
	start(): void;
	stop(): void;
	sendNow(): Promise<void>;
	getStatus(): DailySlackMessageStatus;
}

interface TimeParts {
	hour: number;
	minute: number;
}

interface DateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const DEFAULT_MESSAGE = "Good morning";
const DEFAULT_SCHEDULE_TIME = "08:00";
const DEFAULT_LOGGER: Pick<Console, "info" | "error"> = console;

export function parseDailyTime(value: string): TimeParts {
	const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value);
	if (!match) {
		throw new Error(`Invalid schedule time: ${value}. Expected HH:MM in 24-hour format.`);
	}

	return {
		hour: Number.parseInt(match[1], 10),
		minute: Number.parseInt(match[2], 10),
	};
}

export function getNextDailyOccurrence(now: Date, scheduleTime: string, timeZone: string): Date {
	assertValidTimeZone(timeZone);
	const time = parseDailyTime(scheduleTime);
	const zonedNow = getTimeZoneParts(now, timeZone);

	const candidateToday = zonedDateTimeToUtc(
		{
			year: zonedNow.year,
			month: zonedNow.month,
			day: zonedNow.day,
			hour: time.hour,
			minute: time.minute,
			second: 0,
		},
		timeZone,
	);

	if (candidateToday.getTime() > now.getTime()) {
		return candidateToday;
	}

	const tomorrow = addDays({ year: zonedNow.year, month: zonedNow.month, day: zonedNow.day }, 1);
	return zonedDateTimeToUtc(
		{
			year: tomorrow.year,
			month: tomorrow.month,
			day: tomorrow.day,
			hour: time.hour,
			minute: time.minute,
			second: 0,
		},
		timeZone,
	);
}

export async function postSlackWebhookMessage(
	webhookUrl: string,
	message: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	const response = await fetchFn(webhookUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({ text: message }),
	});

	if (!response.ok) {
		throw new Error(`Slack webhook request failed with ${response.status} ${response.statusText}`);
	}
}

export function createDailySlackMessageScheduler(options: DailySlackMessageOptions): DailySlackMessageScheduler {
	const webhookUrl = options.webhookUrl.trim();
	if (!webhookUrl) {
		throw new Error("webhookUrl is required");
	}

	const message = options.message ?? DEFAULT_MESSAGE;
	const scheduleTime = options.scheduleTime ?? DEFAULT_SCHEDULE_TIME;
	const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
	const enabled = options.enabled ?? true;
	const fetchFn = options.fetch ?? fetch;
	const now = options.now ?? (() => new Date());
	const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
	const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
	const logger = options.logger ?? DEFAULT_LOGGER;

	assertValidTimeZone(timeZone);
	parseDailyTime(scheduleTime);

	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	let nextRunAt: Date | undefined;
	let lastSentOn: string | undefined;
	let active = false;

	const clearPendingTimer = () => {
		if (timer !== undefined) {
			clearTimeoutFn(timer);
			timer = undefined;
		}
	};

	const scheduleNext = () => {
		if (!active || !enabled) {
			nextRunAt = undefined;
			return;
		}

		clearPendingTimer();
		nextRunAt = getNextDailyOccurrence(now(), scheduleTime, timeZone);
		const delayMs = Math.max(0, nextRunAt.getTime() - now().getTime());

		logger.info(
			`[slack-scheduler] Scheduled daily Slack message for ${nextRunAt.toISOString()} (${timeZone} ${scheduleTime})`,
		);
		timer = setTimeoutFn(() => {
			void runScheduledSend();
		}, delayMs);
	};

	const send = async (reason: "scheduled" | "manual") => {
		const dateKey = formatDateKey(now(), timeZone);
		if (reason === "scheduled" && lastSentOn === dateKey) {
			logger.info(`[slack-scheduler] Skipping duplicate send for ${dateKey}`);
			return;
		}

		await postSlackWebhookMessage(webhookUrl, message, fetchFn);
		lastSentOn = dateKey;
		logger.info(`[slack-scheduler] Sent Slack message for ${dateKey}`);
	};

	const runScheduledSend = async () => {
		try {
			await send("scheduled");
		} catch (error) {
			logger.error("[slack-scheduler] Failed to send scheduled Slack message", error);
		} finally {
			scheduleNext();
		}
	};

	return {
		start() {
			active = true;
			if (!enabled) {
				logger.info("[slack-scheduler] Scheduler is disabled");
				nextRunAt = undefined;
				return;
			}
			scheduleNext();
		},

		stop() {
			active = false;
			nextRunAt = undefined;
			clearPendingTimer();
		},

		async sendNow() {
			await send("manual");
			scheduleNext();
		},

		getStatus() {
			return {
				enabled,
				message,
				scheduleTime,
				timeZone,
				nextRunAt,
				lastSentOn,
			};
		},
	};
}

function assertValidTimeZone(timeZone: string): void {
	try {
		Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
	} catch {
		throw new Error(`Invalid time zone: ${timeZone}`);
	}
}

function formatDateKey(date: Date, timeZone: string): string {
	const parts = getTimeZoneParts(date, timeZone);
	return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day
		.toString()
		.padStart(2, "0")}`;
}

function getTimeZoneParts(date: Date, timeZone: string): DateParts {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});

	const parts = formatter.formatToParts(date);
	const lookup = new Map(parts.map((part) => [part.type, part.value]));

	const year = lookup.get("year");
	const month = lookup.get("month");
	const day = lookup.get("day");
	const hour = lookup.get("hour");
	const minute = lookup.get("minute");
	const second = lookup.get("second");

	if (!year || !month || !day || !hour || !minute || !second) {
		throw new Error(`Could not resolve time zone parts for ${timeZone}`);
	}

	return {
		year: Number.parseInt(year, 10),
		month: Number.parseInt(month, 10),
		day: Number.parseInt(day, 10),
		hour: Number.parseInt(hour, 10),
		minute: Number.parseInt(minute, 10),
		second: Number.parseInt(second, 10),
	};
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
	const zoned = getTimeZoneParts(date, timeZone);
	const utcEquivalent = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
	return utcEquivalent - date.getTime();
}

function zonedDateTimeToUtc(parts: DateParts, timeZone: string): Date {
	let utcTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	for (let iteration = 0; iteration < 2; iteration++) {
		utcTime =
			Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
			getTimeZoneOffsetMs(new Date(utcTime), timeZone);
	}
	return new Date(utcTime);
}

function addDays(
	date: { year: number; month: number; day: number },
	days: number,
): {
	year: number;
	month: number;
	day: number;
} {
	const utcDate = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return {
		year: utcDate.getUTCFullYear(),
		month: utcDate.getUTCMonth() + 1,
		day: utcDate.getUTCDate(),
	};
}
