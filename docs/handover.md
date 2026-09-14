# Handover — outstanding work

Audience: whoever picks this up next.

State at handover: 145 tests passing, v1.0.0, commit `f3f7afd`. The service works. Everything below was found by checking the README against the source and a running instance — verified items were reproduced, proposed items are judgement calls.

Ordered by consequence. **Phase 1 is the only phase that is urgent** — it is where the service already knows something is wrong and does not say so.

---

## Phase 1 — Stop losing things quietly

No new capability. Surfaces what the service already knows.

### 1.1 The Jobs page hides failed and dead-lettered jobs — *verified defect*

The dashboard requests `/api/jobs?limit=20` with no status filter, and the server defaults an unfiltered query to **pending only** ([server.ts:740](../src/api/server.ts#L740), [dashboard.html:1078](../public/dashboard.html#L1078)).

On a healthy till the pending list is permanently empty, so the page reads "No recent jobs" while `/health` reports jobs that will never print. A site hit exactly this: health said *"1 job(s) have exhausted their retries"* and the Jobs page showed nothing.

**Fix:** status tabs on the Jobs page, defaulting to all statuses rather than pending. A job that will never print is the most important row the dashboard can show and is currently the one row it hides.

### 1.2 No way to retry a dead-lettered job from the UI — *verified gap*

`POST /api/jobs/:jobId/retry` exists and nothing in the dashboard calls it. An operator whose printer was merely switched off must lose the ticket or use curl.

**Fix:** a Retry button on failed and dead-letter rows. Depends on 1.1 being done first, since those rows are not currently visible.

### 1.3 The README documents a `label` template that does not exist — *verified defect*

`TemplateType` has five values — `receipt`, `kot`, `invoice`, `test`, `raw` ([types/index.ts:154](../src/types/index.ts#L154)) — and the engine registers five renderers ([templates/engine.ts:37-41](../src/templates/engine.ts#L37-L41)). The README's feature list claims six, including `label`.

A POS sending `templateType: "label"` gets a 400 from schema validation. The **role** called Labels is unrelated: it configures a printer, it does not render anything.

**Fix:** implement a label renderer, or strike the claim from the README. Either is fine; shipping a documented template that returns 400 is not — an integrator finds out in production.

### 1.4 The queue has no ceiling — *verified gap*

`QUEUE_FULL` is defined in the error codes ([types/index.ts:729](../src/types/index.ts#L729)) and is **never thrown anywhere**. A printer offline for an hour while the POS keeps sending grows the job store without limit and without complaint.

**Fix:** a configurable ceiling that rejects with `QUEUE_FULL` and a 503, so the POS learns to stop rather than discovering the problem via disk usage.

### 1.5 Surface `health.reasons` on the Overview page — *proposed*

The reasons array is already written as plain sentences meant for a person to read. It is currently reachable only through the API.

---

## Phase 2 — Network printers as first-class

The active use case, and the gap between the two transports is wide: USB has ranked discovery, role-based setup, corroborated status and a repair ladder. LAN has none of it.

Recent work fixed the worst of it — a host-less network printer no longer takes the service down, failures now produce a cause and a fix instead of an errno, and addresses are validated before a socket opens. What remains:

### 2.1 Role-based setup cannot create a network printer — *verified gap*

`buildRoleConfig` hard-codes `type: PrinterType.USB` ([printer-roles.ts:155](../src/printers/printer-roles.ts#L155)), so the guided flow is USB-only and LAN users fall back to the manual form.

**Fix:** take a transport argument, so a LAN kitchen printer gets the same derived id, width and capability profile as a USB one.

### 2.2 Test connection before saving — *proposed*

A button that opens a socket to the entered address and reports the result through `network-diagnosis`, which already produces the right sentence for every failure. Turns a five-minute guess-and-check into one click.

Highest-value single addition for a first-time LAN install.

### 2.3 Network status is not corroborated — *verified gap*

`NetworkPrinterAdapter.getStatus()` returns a value without writing it to state, so the reconcile loop reads a status the adapter never recorded. It also treats a silent socket as online.

USB has an entire verdict module for this problem ([printer-resolver.ts](../src/printers/printer-resolver.ts)). The network path should reuse that thinking, including real `DLE EOT` parsing for paper-out and cover-open.

---

## Phase 3 — Deferred

Real, but none of it is urgent. Listed so it is not rediscovered from scratch.

| Item | Why it is deferred |
|---|---|
| Subnet discovery for LAN printers (sweep /24 for open 9100) | 2.2 removes most of the pain; discovery is convenience on top |
| Single-connection guard — most network thermal printers accept one TCP connection, so two tills on one kitchen printer produce `ECONNRESET` | Diagnosed clearly already; only bites multi-till sites |
| Degraded-state alerting (webhook or POS callback on status transition) | Health is well designed and nobody watches it — but Phase 1 makes it visible in the UI first |
| Multi-printer soak across mixed transports | Concurrency is correctly gated; existing soak history is single-printer |
| First-run setup wizard | All the pieces exist as separate screens; this only orders them |
| In-place updates — the deployed copy does not self-update | Tolerable at five sites; blocking at fifty |

### One decision, not a task

The API key is injected into the dashboard HTML and `/dashboard` is exempt from key checks ([server.ts:1730](../src/api/server.ts#L1730), [server.ts:333-340](../src/api/server.ts#L333-L340)). With `allowPrivateNetwork` enabled, anyone on the restaurant LAN who opens the page receives the key.

That may be the right trade for a single-operator till. It is clearly wrong for a shared network. Either way it should be a documented decision rather than an emergent one — decide it, write it down in [web-integration.md](web-integration.md), and move on.

---

## Notes for whoever picks this up

- **`pkill` does not kill Windows node processes.** Use `Stop-Process`. Three stale instances quietly held ports 9150–9152 during this work and every reading came from the wrong instance until the service log gave it away. Confirm the bound port from the log before trusting any test result.
- **The instance lock will block a second copy** and names the holding PID. That is correct behaviour, not a fault.
- **`Restart-Service` does not cycle the Node child process.** A new build will not take effect after a plain service restart — use the dashboard restart or `POST /api/service/restart`.
- **Config changes on load are conservative by design.** The retry migration only raises values at or below the old default; `0` means "never retry" and is left alone. Keep that principle for any future migration — an upgrade that overrides a deliberate setting is how upgrades lose trust.
