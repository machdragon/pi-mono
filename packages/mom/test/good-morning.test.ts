import test from "node:test";
import { strict as assert } from "assert";
import { Cron } from "croner";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
	type GoodMorningConfig,
	GoodMorningScheduler,
	getDateKeyInTimezone,
	toDailyCronSchedule,
} from "../src/good-morning.js";

test("toDailyCronSchedule converts 08:00 to a daily cron expression", () => {
	assert.equal(toDailyCronSchedule("08:00"), "0 8 * * *");
	assert.equal(toDailyCronSchedule("17:45"), "45 17 * * *");
});

test("toDailyCronSchedule rejects invalid times", () => {
	assert.throws(() => toDailyCronSchedule("8:00"), /Invalid good morning time/);
	assert.throws(() => toDailyCronSchedule("24:00"), /Invalid good morning time/);
	assert.throws(() => toDailyCronSchedule("08:60"), /Invalid good morning time/);
});

test("cron nextRun stays on the same day before 8am and moves to the next day after 8am", () => {
	const cron = new Cron(toDailyCronSchedule("08:00"), { timezone: "Europe/Vienna" });

	assert.equal(cron.nextRun(new Date("2026-04-02T05:30:00.000Z"))?.toISOString(), "2026-04-02T06:00:00.000Z");
	assert.equal(cron.nextRun(new Date("2026-04-02T06:30:00.000Z"))?.toISOString(), "2026-04-03T06:00:00.000Z");
});

test("getDateKeyInTimezone uses the configured timezone", () => {
	const date = new Date("2026-04-02T23:30:00.000Z");
	assert.equal(getDateKeyInTimezone(date, "UTC"), "2026-04-02");
	assert.equal(getDateKeyInTimezone(date, "Asia/Tokyo"), "2026-04-03");
});

test("GoodMorningScheduler only posts once per day", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "mom-good-morning-"));
	const messages: Array<{ channel: string; text: string }> = [];
	const config: GoodMorningConfig = {
		channelId: "C123",
		text: "Good morning",
		time: "08:00",
		schedule: toDailyCronSchedule("08:00"),
		timezone: "UTC",
		stateFilePath: join(workspaceDir, ".good-morning-state.json"),
	};

	try {
		const scheduler = new GoodMorningScheduler(config, {
			postMessage: async (channel, text) => {
				messages.push({ channel, text });
				return "1";
			},
			logBotResponse: () => {},
		});

		assert.equal(await scheduler.trigger(new Date("2026-04-02T08:00:00.000Z")), true);
		assert.equal(await scheduler.trigger(new Date("2026-04-02T08:30:00.000Z")), false);
		assert.equal(await scheduler.trigger(new Date("2026-04-03T08:00:00.000Z")), true);
		assert.deepEqual(messages, [
			{ channel: "C123", text: "Good morning" },
			{ channel: "C123", text: "Good morning" },
		]);
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
});
