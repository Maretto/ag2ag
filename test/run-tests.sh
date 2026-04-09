#!/bin/bash
set -e
cd /root/.openclaw/workspace/creations/a2a-local

# Kill any leftover on port 5001
kill $(lsof -ti:5001) 2>/dev/null || true
sleep 1

# Start echo agent
node examples/echo-agent.js &
ECHO_PID=$!
sleep 2

echo "=== 1. AgentCard ==="
curl -s http://127.0.0.1:5001/card | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Name: {d[\"name\"]} | Skills: {[s[\"name\"] for s in d[\"skills\"]]}')"

echo ""
echo "=== 2. Send message ==="
TASK=$(curl -s -X POST http://127.0.0.1:5001/task \
  -H 'Content-Type: application/json' \
  -d '{"role":"user","parts":[{"type":"text","text":"Test message"}]}')
TASK_ID=$(echo "$TASK" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Task: $TASK_ID"

echo ""
echo "=== 3. Wait and get task ==="
sleep 1
TASK_RESULT=$(curl -s "http://127.0.0.1:5001/task/$TASK_ID")
STATE=$(echo "$TASK_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['status']['state'])")
ARTIFACT=$(echo "$TASK_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['artifacts'][0]['parts'][0]['text'])")
echo "State: $STATE | Artifact: $ARTIFACT"

echo ""
echo "=== 4. Task persistence (check JSONL) ==="
if [ -f "data/tasks/echo-agent.jsonl" ]; then
  LINES=$(wc -l < data/tasks/echo-agent.jsonl)
  echo "JSONL file exists: $LINES task(s)"
else
  echo "ERROR: No JSONL file"
  kill $ECHO_PID 2>/dev/null
  exit 1
fi

echo ""
echo "=== 5. CLI status --health ==="
node src/cli.js status --health

echo ""
echo "=== 6. CLI call ==="
node src/cli.js call echo-agent "CLI integration test"

echo ""
echo "=== 7. CLI call --raw ==="
node src/cli.js call echo-agent "raw test" --raw

echo ""
echo "=== 8. Lifecycle: start real service ==="
node src/cli.js start api-gateway

echo ""
echo "=== 9. Lifecycle: status of real service ==="
node src/cli.js status --health

# Cleanup
kill $ECHO_PID 2>/dev/null
wait $ECHO_PID 2>/dev/null

echo ""
echo "=== ALL TESTS PASSED ==="
