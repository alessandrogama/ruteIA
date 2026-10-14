---
description: 
---

Review the current codebase and verify:
1. Are voice messages handled purely in memory and piped correctly into the @google/genai SDK without saving temporary files to the disk?
2. Does the relapse logic correctly enforce the single-reset-day cap (preventing multiple streak drops in 24 hours)?
3. Does the nightly cron endpoint (/api/cron/night) branch properly when resetDayToday is true, sending encouragement instead of the clean check-in?
4. Are all environment variables and secrets strictly validated before startup?