import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDailySlackMessageScheduler,
	getNextDailyOccurrence,
	parseDailyTime,
	postSlackWebhookMessage,
} from "../src/slack-scheduler.js";

describe("slack scheduler", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("parses HH:MM schedule times", () => {
		expect(parseDailyTime("08:00")).toEqual({ hour: 8, minute: 0 });
		expect(parseDailyTime("23:59")).toEqual({ hour: 23, minute: 59 });
		expect(() => parseDailyTime("8:00")).toThrow("Invalid schedule time");
		expect(() => parseDailyTime("24:00")).toThrow("Invalid schedule time");
	});

	it("calculates the next occurrence in the configured time zone", () => {
		const nextUtc = getNextDailyOccurrence(new Date("2026-04-02T07:30:00.000Z"), "08:00", "UTC");
		expect(nextUtc.toISOString()).toBe("2026-04-02T08:00:00.000Z");

		const nextNewYork = getNextDailyOccurrence(new Date("2026-04-02T11:30:00.000Z"), "08:00", "America/New_York");
		expect(nextNewYork.toISOString()).toBe("2026-04-02T12:00:00.000Z");
	});

	it("posts Slack webhook payloads", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));

		await postSlackWebhookMessage("https://hooks.slack.test/services/abc", "Good morning", fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("https://hooks.slack.test/services/abc", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Good morning" }),
		});
	});

	it("schedules and sends the daily Slack message once per day", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-02T07:59:00.000Z"));

		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
		const logger = {
			info: vi.fn<(message?: unknown, ...optionalParams: unknown[]) => void>(),
			error: vi.fn<(message?: unknown, ...optionalParams: unknown[]) => void>(),
		};

		const scheduler = createDailySlackMessageScheduler({
			webhookUrl: "https://hooks.slack.test/services/abc",
			fetch: fetchMock,
			timeZone: "UTC",
			logger,
		});

		scheduler.start();
		expect(scheduler.getStatus().nextRunAt?.toISOString()).toBe("2026-04-02T08:00:00.000Z");

		await vi.advanceTimersByTimeAsync(60_000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: "Good morning" }));
		expect(scheduler.getStatus().lastSentOn).toBe("2026-04-02");
		expect(scheduler.getStatus().nextRunAt?.toISOString()).toBe("2026-04-03T08:00:00.000Z");
		expect(logger.info).toHaveBeenCalled();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("skips the scheduled send when sendNow already delivered the message that day", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-02T07:59:00.000Z"));

		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));

		const scheduler = createDailySlackMessageScheduler({
			webhookUrl: "https://hooks.slack.test/services/abc",
			fetch: fetchMock,
			timeZone: "UTC",
		});

		scheduler.start();
		await scheduler.sendNow();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(scheduler.getStatus().lastSentOn).toBe("2026-04-02");
		expect(scheduler.getStatus().nextRunAt?.toISOString()).toBe("2026-04-03T08:00:00.000Z");
	});
});
