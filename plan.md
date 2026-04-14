1. **Task memory leak — add automatic pruning of completed/failed tasks with configurable TTL and max count**
   - In `src/task-store.js`, update the `startAutoCleanup` and `prune` functions to prune tasks based on a TTL *and* a max count (e.g. keep at most `MAX_TASKS_RETAINED` tasks). Add `AG2AG_CLEANUP_MAX_TASKS` configuration to `src/config.js` with a default of, say, 1000.
2. **Health endpoint — return real metrics (task counts, memory, uptime, degraded status)**
   - In `src/server.js`, update the `GET /health` endpoint handler to include memory usage (`process.memoryUsage()`), more detailed task counts (active, completed, failed from the task store or metrics), and a `degraded` status boolean if memory is getting too high or too many tasks are failing.
3. **Add synchronous /call endpoint that blocks until completion**
   - In `src/server.js`, add a new `POST /call` endpoint. It should do what `POST /task` does but then internally wait for the task to complete (or fail/cancel) using a loop or by listening to the `EventEmitter`, and then return the final result directly instead of returning the task ID immediately.
4. **Validate params and return clear errors on mismatch**
   - In `src/server.js` within `_handleRequest`, when handling `POST /task` and `POST /call`, add validation for the incoming body (e.g., ensure it's a valid object, has `role`, `parts`, etc. according to A2A spec, or at least some basic structure). Return 400 Bad Request with clear messages if validation fails.
5. **Add built-in request/response logging**
   - In `src/server.js`, wrap the `_handleRequest` execution with logging (using `console.log` or similar) that logs the method, path, status code, and duration of the request.
6. **SIGHUP hot-reload support**
   - In `src/server.js`, add a listener for `process.on('SIGHUP', ...)` that reloads configuration or anything else that can be hot-reloaded (like registry or agent card if applicable). Maybe simply reload `config.js` or log that it was reloaded, and restart auto-cleanup.
7. **Document env var conventions for paths**
   - In `README.md`, update the Configuration section to explicitly mention environment variables used for paths like `AG2AG_REGISTRY_PATH` (seen in cli.js), `AG2AG_STORE_DIR` (used in task store if added), etc.
8. **Pre-commit steps**
   - Call `pre_commit_instructions` tool to run checks.
