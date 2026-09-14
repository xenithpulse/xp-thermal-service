# Handover — outstanding work

Audience: whoever picks this up next.

State: 186 tests passing, v1.0.0. The service works. Everything below was found by checking the README against the source and a running instance — verified items were reproduced, proposed items are judgement calls.

Ordered by consequence. **Phases 1, 2 and 3 are done.** What remains is listed under [Still open](#still-open).

---

## Phase 1 — Stop losing things quietly ✅ Done

No new capability. Surfaces what the service already knows.

**Shipped.** Kept below as the record of what was wrong and why, since the reasoning outlives the fix. One item (1.2) turned out not to be a defect at all — see its note.

### 1.1 The Jobs page hides failed and dead-lettered jobs — *verified defect* — **fixed**

The dashboard requests `/api/jobs?limit=20` with no status filter, and the server defaults an unfiltered query to **pending only** ([server.ts:740](../src/api/server.ts#L740), [dashboard.html:1078](../public/dashboard.html#L1078)).

On a healthy till the pending list is permanently empty, so the page reads "No recent jobs" while `/health` reports jobs that will never print. A site hit exactly this: health said *"1 job(s) have exhausted their retries"* and the Jobs page showed nothing.

**Done.** An unfiltered `/api/jobs` now returns the most recent jobs of every status, `status` accepts a comma-separated list, and the Jobs page has tabs — All / Needs attention / Waiting / Completed — with a count badge on *Needs attention* so a stuck job advertises itself. Empty states name which list is empty rather than claiming nothing has happened.

Verified live against the old behaviour: with three jobs parked retrying, `status=pending` returned 0 while unfiltered returned 3.

### 1.2 No way to retry a dead-lettered job from the UI — **was not a defect**

I was wrong about this in the first draft. The Retry button already exists in `renderJobRows` and `retryJob()` already calls `POST /api/jobs/:jobId/retry`. It was never reachable only because those rows never rendered — so 1.1 fixed it, and there was nothing else to build.

### 1.3 The README documents a `label` template that does not exist — *verified defect* — **fixed**

`TemplateType` has five values — `receipt`, `kot`, `invoice`, `test`, `raw` ([types/index.ts:154](../src/types/index.ts#L154)) — and the engine registers five renderers ([templates/engine.ts:37-41](../src/templates/engine.ts#L37-L41)). The README's feature list claims six, including `label`.

A POS sending `templateType: "label"` gets a 400 from schema validation. The **role** called Labels is unrelated: it configures a printer, it does not render anything.

**Done.** Struck the claim rather than implementing a renderer — a label template with no agreed payload contract would just be a second false promise. The README now states the five types are the whole set, and explains that the `label` *role* is a different concept from a template.

Implementing a real label renderer remains open as a feature, not a defect.

### 1.4 The queue has no ceiling — *verified gap* — **fixed**

`QUEUE_FULL` is defined in the error codes ([types/index.ts:729](../src/types/index.ts#L729)) and is **never thrown anywhere**. A printer offline for an hour while the POS keeps sending grows the job store without limit and without complaint.

**Done.** `queue.maxQueueDepth` (default 2000, `0` disables) rejects new work with `QUEUE_FULL` and a 503 naming the limit. Two deliberate exclusions:

- **A duplicate idempotency key is never blocked.** A POS retrying a receipt it already submitted must keep getting that job back; if a full queue turned retries into errors it would destroy exactly the tickets idempotency exists to protect, at the worst moment.
- **Only unfinished work counts.** Completed and dead-lettered jobs are history, bounded by the cleanup sweep. Counting them would make a busy healthy till refuse receipts after N ever.

Worth knowing for anything similar: the first version used `getStats()`, whose `pending` counts the exact status `pending` and misses `queued`, `printing` and `retry_scheduled`. A switched-off printer parks its whole backlog in `retry_scheduled`, so the ceiling read zero precisely when it should trip. The unit tests passed because their jobs were all `pending`; only the live check caught it. There is now a `countUnfinished()` on the store and a regression test.

### 1.5 Surface `health.reasons` on the Overview page — *proposed* — **done**

The reasons array is already written as plain sentences meant for a person to read. It now appears at the top of Overview, with the severity carried by a left stripe rather than a fill. A dead-letter note on an otherwise healthy service reads as "Worth knowing" rather than an alarm, matching how `decideHealth` itself treats it.

---

## Phase 2 — Network printers as first-class ✅ Done

The active use case, and the gap between the two transports is wide: USB has ranked discovery, role-based setup, corroborated status and a repair ladder. LAN has none of it.

Recent work fixed the worst of it — a host-less network printer no longer takes the service down, failures now produce a cause and a fix instead of an errno, and addresses are validated before a socket opens. What remains:

### 2.1 Role-based setup cannot create a network printer — *verified gap* — **fixed**

`buildRoleConfig` hard-codes `type: PrinterType.USB` ([printer-roles.ts:155](../src/printers/printer-roles.ts#L155)), so the guided flow is USB-only and LAN users fall back to the manual form.

**Done.** `buildNetworkRoleConfig` builds the same role config over TCP, and `/api/printers/setup` takes either `windowsName` or `host`+`port` (and refuses both at once). Two things a network printer cannot derive the way USB does get honest defaults rather than guesses dressed up as detection: paper width (48, overridable) and identity, where the address *is* the identity.

Verified live: posting `{role:"kitchen", host, port}` yields `id=kitchen`, `type=network`, the KOT capability profile, drawer off, and an honest "not ready" with the reason.

### 2.2 Test connection before saving — *proposed* — **done**

A button that opens a socket to the entered address and reports the result through `network-diagnosis`, which already produces the right sentence for every failure. Turns a five-minute guess-and-check into one click.

Highest-value single addition for a first-time LAN install.

**Done.** `POST /api/printers/test-connection`, with a **Test connection** button in the printer form. It deliberately prints nothing — a test that emits paper cannot be run casually at a till during service — and it says plainly that an open socket proves something is *listening*, not that it speaks ESC/POS.

### 2.3 Network status is not corroborated — *verified gap* — **fixed**

`NetworkPrinterAdapter.getStatus()` returns a value without writing it to state, so the reconcile loop reads a status the adapter never recorded. It also treats a silent socket as online.

USB has an entire verdict module for this problem ([printer-resolver.ts](../src/printers/printer-resolver.ts)). The network path should reuse that thinking, including real `DLE EOT` parsing for paper-out and cover-open.

**Done, and it was worse than described.** Beyond never writing state, the adapter sent `DLE EOT 1` and then read bit 3 as paper-out and bit 2 as cover-open. Under `n=1` those bits are **offline** and **the cash drawer pin** — so a printer that was merely switched off reported itself out of paper, sending someone to change a roll that was already full.

New [escpos-status.ts](../src/printers/escpos-status.ts) carries the bit tables for `n=1/2/4` as pure functions, validates the four fixed bits every status byte has (so bytes from something that is not a printer are not read as status), and only asks *why* a printer is offline when it says it is. A printer that does not answer `DLE EOT` at all stays online and says so — plenty of cheap units never implement it over a raw socket, and calling those faulty would take working printers offline.

---

## Phase 3 — Resilience and reach ✅ Done

Three of the six deferred items were built. The rest are under [Still open](#still-open) with the reason they were left.

### 3.1 Subnet discovery — **done**

`GET /api/printers/discover-network` sweeps this machine's own /24-or-smaller subnets for an open 9100, with a **Scan network** button in Find Printers. A discovered address fills straight into the Add Printer form.

An open port is not a printer — print servers, terminal servers and unrelated software sit on 9100 too — so each candidate is asked `DLE EOT 1` and the reply is checked for the fixed bits. Confirmed printers sort first; a silent device is still listed but labelled honestly rather than presented as a printer.

Bounded three ways (concurrency, per-host timeout, overall budget) because the dashboard waits on the request, and it returns a partial list rather than nothing if the budget runs out. Measured on a real LAN: **506 addresses in 3.3 s**.

Only /24-or-smaller subnets are swept. A /16 is 65k probes and nobody's till is on one; a /20 (Hyper-V's default switch) is 4094 and is not where the printer is either.

### 3.2 Let go of an idle printer — **done**

Almost every network thermal printer accepts exactly **one** TCP connection at a time. The adapter held a persistent socket, so while it was connected no other machine could print — and two tills sharing a kitchen printer is an ordinary deployment. The second till got `ECONNRESET` all evening and the reason was us.

An idle connection is now released after 60 s of no print activity (`metadata.idleReleaseMs`; `0` holds it indefinitely), and reconnects on demand. Cost is one reconnect per ticket after a quiet spell — a few milliseconds on a LAN.

Two things that matter and were nearly got wrong:

- **It cannot use `socket.setTimeout`.** That timer counts *all* socket traffic, and the health check writes a status request every 30 s — so the socket was never idle by its reckoning and the release could never have fired. Idleness is measured against real print activity instead.
- **A released printer stays `ONLINE`.** It is not faulty; we spoke to it and chose to hang up. Reporting `OFFLINE` would make `/health` call the service degraded and, with 3.3 enabled, page someone every time a quiet printer let go of its socket.

### 3.3 Degraded-state alerting — **done**

`alerts` in config.json (off by default) POSTs to a webhook when health changes. It reads exactly the inputs `/health` reads and runs them through the same `decideHealth`, so an alert and the API can never disagree.

The hard part is not sending a webhook, it is not sending thousands — a printer at the edge of its Wi-Fi range flaps all evening, and an alerter that fires on every change becomes noise people mute, which is indistinguishable from no alerting at all. So: a new status must hold for N consecutive samples before it is believed, at most one alert per window, and **a recovery always sends** and is never rate-limited away.

Verified live end to end, both directions:

```json
{"status":"degraded","previousStatus":"healthy","recovered":false,
 "reasons":["None of the 1 configured printer(s) are online (0 in error, 1 offline)."]}
{"status":"healthy","previousStatus":"degraded","recovered":true, ...}
```

Reasons are passed through verbatim — an alert that paraphrased them would drift from what the dashboard shows for the same fault.

---

<a id="still-open"></a>
## Still open

| Item | Why it was left |
|---|---|
| Multi-printer soak across mixed transports | Concurrency is correctly gated and the pieces are now testable in isolation; this needs a rig and real hardware more than it needs code |
| First-run setup wizard | Every piece exists as a separate screen; this only orders them. Worth doing, but it is polish on a service that now works |
| In-place updates — the deployed copy does not self-update | Tolerable at five sites; blocking at fifty. The largest remaining item by far, and the one most likely to need a design rather than a patch |
| A real `label` template renderer | Removed from the README as a false claim rather than invented. Needs an agreed payload contract before it is worth building |

### One decision, not a task

The API key is injected into the dashboard HTML and `/dashboard` is exempt from key checks ([server.ts:1730](../src/api/server.ts#L1730), [server.ts:333-340](../src/api/server.ts#L333-L340)). With `allowPrivateNetwork` enabled, anyone on the restaurant LAN who opens the page receives the key.

That may be the right trade for a single-operator till. It is clearly wrong for a shared network. Either way it should be a documented decision rather than an emergent one — decide it, write it down in [web-integration.md](web-integration.md), and move on.

---

## Notes for whoever picks this up

- **`pkill` does not kill Windows node processes.** Use `Stop-Process`. Three stale instances quietly held ports 9150–9152 during this work and every reading came from the wrong instance until the service log gave it away. Confirm the bound port from the log before trusting any test result.
- **The instance lock will block a second copy** and names the holding PID. That is correct behaviour, not a fault.
- **`Restart-Service` does not cycle the Node child process.** A new build will not take effect after a plain service restart — use the dashboard restart or `POST /api/service/restart`.
- **Config changes on load are conservative by design.** The retry migration only raises values at or below the old default; `0` means "never retry" and is left alone. Keep that principle for any future migration — an upgrade that overrides a deliberate setting is how upgrades lose trust.
