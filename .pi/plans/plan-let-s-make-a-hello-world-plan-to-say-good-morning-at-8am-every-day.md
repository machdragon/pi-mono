Plan:

1. Define the target behavior
   - At 8:00 AM every day, emit a simple `Hello world` / `Good morning` message.
   - Decide where it should appear:
     - terminal output
     - TUI notification
     - desktop/system notification
     - chat message / webhook

2. Choose the scheduling mechanism
   - In-app scheduler if this should run while the app is open
   - OS scheduler if this should run independently
     - cron on Linux/macOS
     - launchd on macOS
     - Task Scheduler on Windows

3. Implement a minimal hello-world version
   - Create a small function:
     - get current local time
     - produce `"Good morning"`
     - send/output it to the selected destination

4. Add daily scheduling
   - Trigger at local 08:00
   - Prevent duplicate sends on restart if needed
   - Handle timezone explicitly

5. Add configuration
   - message text
   - schedule time, default `08:00`
   - timezone, if needed
   - enable/disable flag

6. Add basic validation
   - log when the job is scheduled
   - log when the message is sent
   - verify behavior around app restart and missed runs

7. Optional follow-ups
   - weekdays only
   - different messages by day
   - user-configurable reminder channel

Minimal hello-world scope:
- hardcoded message: `Good morning`
- hardcoded time: `08:00`
- local timezone
- log to console first

If you want, I can turn this into an implementation plan for a specific package in this repo. If so, tell me which module:
- `packages/agent`
- `packages/coding-agent`
- `packages/tui`
- `packages/web-ui`
- something else