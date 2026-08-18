# How this system fits together

One app, two roles, one codebase.

**Data aggregation.** The fee and revenue tool pages (Projects Index,
Ingestion Studio, Revenue Projections, Staffing Matrix and the rest) collect
the team's project, fee, staffing and rate data. The shared state lives in
four Box files the tool maintains: `projects.json`, `rates.json`,
`staff.json`, `studio.json`.

**User interface.** Reporting views read that same data back. The main one is
**Executive Reporting** (`exec-reporting/`), a read-only leadership module
over all four files: pipeline against budget, leaders, clients, rates,
locations, delivery and data confidence. It is restricted to the
sees-all-projects list and never writes.

History: Executive Reporting began as a standalone app maintained by KY. It
was integrated into this codebase in August 2026 and the standalone was
retired. The Maintainers Runbook carries the operational detail.

Not part of this system: KY separately produces a revenue and profit analysis
from the Savills finance team's monthly statements. It shares no data or code
with this tool.
