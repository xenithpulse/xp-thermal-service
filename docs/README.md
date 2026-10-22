# Documentation

| Document | Audience | Read it when |
|---|---|---|
| [install.md](install.md) | Whoever sets up the till | Installing on a new machine, or verifying an install |
| [daily-use.md](daily-use.md) | Site support | Running the dashboard, adding printers, routine operation |
| [troubleshooting.md](troubleshooting.md) | Site support | Something is broken. Symptom-first |
| [web-integration.md](web-integration.md) | Developer integrating a web app | Driving the printers from your own application over HTTP |
| [SERVICE-MODE.md](SERVICE-MODE.md) | POS and fleet installers | Running Thermal Bridge as a Windows service, and how Pulsar POS uses it |
| [BUILD.md](BUILD.md) | Maintainers | How the exe and installer are built, signed and published |
| [handover.md](handover.md) | Whoever picks up development | Outstanding work, in phases |

The [top-level README](../README.md) carries the full endpoint list, configuration and architecture.

---

## The one thing everyone gets wrong

The service binds the **first free port from 9100** (up to 9109), and 9100 is the RAW/JetDirect printing port that other software frequently already holds.

Never hard-code 9100. Resolve it from `active_port.txt`:

```powershell
type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt"   # the app
type "$env:ProgramData\ThermalBridge\active_port.txt"    # a Windows service install
```

or ask each port in 9100–9110 for `/health` and match `"service": "xp-thermal-service"`. Every document here opens with this because it is the most common support call.
