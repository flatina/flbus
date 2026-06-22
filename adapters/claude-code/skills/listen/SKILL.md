---
name: listen
description: Listen for incoming flbus messages on or off for this session — "watch your inbox", "listen for messages", "stop watching".
---

# flbus listen

Listen mode: the session sleeps until a message arrives, then wakes and reads it automatically. Only ever on the user's explicit ask (it bypasses the read gate).

On — run as a **background task**, then end the turn; its exit output delivers the messages:

```
flbus listen
```

After each delivery: report what arrived, re-arm the same command, end the turn. The mode stays on until turned off.

Off: stop the background task, then the same command with `--off`.
