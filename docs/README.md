# Documentation

| Document | Audience | Read it when |
|---|---|---|
| [install.md](install.md) | On-site IT installer | Deploying to a new machine, or verifying an install |
| [daily-use.md](daily-use.md) | Installer / site support | Running the dashboard, adding printers, routine operation |
| [troubleshooting.md](troubleshooting.md) | Installer / site support | Something is broken. Symptom-first |
| [web-integration.md](web-integration.md) | Developer integrating a web app | Driving the printers from your own application over HTTP |

The [top-level README](../README.md) remains the architecture and design reference, and carries the full endpoint list, configuration schema and internals.

---

## The one thing everyone gets wrong

The service binds the **first free port in 9100-9109**, and 9100 is the RAW/JetDirect printing port that other software frequently already holds.

Never hard-code 9100. Resolve it:

```powershell
type "$env:ProgramData\XPThermalService\active_port.txt"
```

or ask each port in the range for `/health` and match `"service": "xp-thermal-service"`. Every document here opens with this because it is the most common support call.
