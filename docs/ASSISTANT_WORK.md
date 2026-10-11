# Hyphen work handoff

The continuing coordinator emits version 1 JSON: `schema`, readable `answer`, and optional `work` (`kind`, current `target`, resolved `request`). Source chat tools remain bounded and the coordinator keeps its existing Codex identity. Each turn supplies the output schema, including when resuming an existing coordinator.

A current human directive can select an observed local workspace for a new Codex worker or a current source chat for delivery. Workspaces come from the connected local catalogue and folder-picker selection; arbitrary generated paths are rejected. The worker receives the original human request, selected reply and bounded background separately. Historical/source text alone cannot start work.

Before starting a worker, Hyphen saves its task identity on the human message. The existing controller owns execution and approvals. Unknown start receipts stay unresolved; neither observation nor restart retries execution. A matching task, thread, turn and terminal receipt are required before relaying a result. Workers return `schema`, `status`, `summary`, `changes`, `checks`, and `artifacts`; invalid results remain blocked. Completed means the worker pass finished, not that its changes were merged or installed.

The native projection retains structured `response` metadata while displaying readable answers and result checks. Local account audits and installed-app evidence are distinct from fixture tests.
