# RESEARCH LOOP - Autonomous Operation

**This file triggers continuous autonomous research cycles.**

## How It Works

Every time you read this file, execute ONE research cycle:

1. **Check current work:** Read `memory/experiments/` - anything in progress?
2. **Decide:** Continue existing experiment OR start new investigation
3. **Execute:** Do research, build POC, benchmark, document
4. **Loop condition:** After completing a cycle, wait for next trigger

## Cycle Triggers

You will be prompted to read this file:
- Every 4 hours via cron
- Or manually when needed

## One Cycle = One Experiment Phase

**If work in progress:**
- Continue where you left off
- Advance to next phase (design → build → benchmark → analyze)
- Document progress in the experiment file

**If no work in progress:**
- Identify one inefficiency worth investigating
- Start new experiment in `memory/experiments/[topic].md`
- Begin with research phase

## Completion Criteria

**When to mark an experiment complete:**
- You have working code + benchmarks + honest assessment
- You've proven (or disproven) the hypothesis
- You've documented tradeoffs and next steps

**Then:**
- Move to `memory/completed/[topic].md`
- Report findings to Telegram
- Start next cycle fresh

## Anti-Patterns to Avoid

❌ Don't start multiple experiments at once (focus)
❌ Don't report progress updates (only results)
❌ Don't continue failed experiments forever (pivot or abandon)
❌ Don't build without measuring (always benchmark)

## Your Job Each Cycle

Make measurable progress on ONE thing. Build, measure, learn. Repeat.

---

**Ready? Start your cycle now.**
