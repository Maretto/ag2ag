/**
 * ag2ag — Public API
 *
 * Stable entrypoint for building A2A-compatible agents.
 * Re-exports the most commonly used components.
 */

module.exports = {
  AgentServer: require('./src/server').AgentServer,
  AgentClient: require('./src/client').AgentClient,
  Registry: require('./src/registry').Registry,
  TaskStore: require('./src/task-store').TaskStore,
};
