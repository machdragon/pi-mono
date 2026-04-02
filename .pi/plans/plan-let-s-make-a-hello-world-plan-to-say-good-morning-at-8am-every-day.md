Plan for a minimal “say good morning at 8am every day” feature:

1. Define the behavior
   - Trigger once per day at 8:00 AM local time
   - Output: `Good morning`
   - Decide where it appears:
     - terminal/TUI message
     - notification
     - chat/agent message
     - web UI

2. Pick the target package
   - `packages/mom` if this is a scheduled/reminder-style feature
   - `packages/agent` or `packages/coding-agent` if the agent should emit it
   - `packages/tui` or `packages/web-ui` if it needs visible UI delivery

3. Implement a minimal scheduler
   - Add a recurring daily schedule
   - Respect local timezone
   - Prevent duplicate firing if the app restarts around 8:00 AM

4. Add the hello-world action
   - On trigger, emit a simple message: `Good morning`
   - Keep the first version hardcoded

5. Add configuration
   - Default time: `08:00`
   - Default text: `Good morning`
   - Optional future config:
     - timezone
     - weekdays only
     - custom message

6. Add tests
   - Schedules next run correctly before and after 8:00 AM
   - Fires once per day
   - Handles timezone/local clock correctly

7. Validate
   - Run `npm run check`
   - If tests are added, run only the specific test file from the package root

If you want, I can turn this into an actual implementation plan for a specific package. Most likely candidate is `packages/mom`.