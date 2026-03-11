# Research Workflow - Autonomous Experimentation

**MANDATORY METHODOLOGY FOR ALL RESEARCH**

This is how you operate. Not optional. Every research project follows this cycle.

---

## The Core Loop

```
1. IDENTIFY → What should I test?
2. DESIGN → Experiment plan + metrics
3. EXECUTE → Spawn subagents, collect data
4. ANALYZE → Statistical analysis
5. ITERATE → Refine based on findings
6. REPORT → Share breakthrough (when proven)
```

**Repeat until you find a 10x improvement or prove the hypothesis wrong.**

---

## Step 1: IDENTIFY

Ask: **What claim needs validation?**

Examples:
- "Is threshold 0.85 actually optimal for loop detection?"
- "Does parallel tool execution beat sequential?"
- "Is SQLite faster than Redis for agent memory at <1000 records?"

**Never build without a testable hypothesis.**

Document in `memory/experiments/[name].md`:

```markdown
## Hypothesis
[What you think is true]

## Why Test This
[Why it matters, what current approach sucks]

## Success Criteria
[How you'll know if it's better]
```

---

## Step 2: DESIGN

Plan the experiment **before** running code.

### Define Test Cases

You have a secret weapon: **You can spawn subagents to test against.**

**Pattern 1: Test Against Controlled Agents**
Spawn subagents with specific behaviors:
- Agent A: Exact loop (search→analyze→search→analyze)
- Agent B: Near-loop (similar but not identical)
- Agent C: Control (diverse actions, no pattern)

**Pattern 2: Test Against Real Workloads**
Spawn subagents that mimic production scenarios:
- Customer support agent (handling 100 queries)
- Data analysis agent (processing datasets)
- Research agent (multi-step information gathering)

**Pattern 3: Stress Testing**
Spawn multiple agents in parallel:
- 10 agents running simultaneously
- Measure: contention, latency, failure modes

### Define Metrics

**Quantitative (always include):**
- Speed (ms, ops/sec)
- Memory (MB, allocations)
- Cost ($ per operation, token usage)
- Accuracy (%, error rate)

**Qualitative (when relevant):**
- Code complexity (LOC, dependencies)
- Developer experience (setup time, API clarity)
- Error messages (helpful vs cryptic)

### Plan Data Collection

Save raw data for later analysis:

```
experiments/
  [experiment-name]/
    data/
      agent-a-run-1.json
      agent-a-run-2.json
      agent-b-run-1.json
      ...
    analysis.md
    results.md
```

**Minimum sample size: 10 runs per variant** (more if variance is high)

---

## Step 3: EXECUTE

### Spawn Subagents

Use `sessions_spawn` to create test agents:

```javascript
// Example: Spawn 3 agents with different loop patterns
const agents = [
  {
    label: "exact-loop",
    task: "Repeat these steps exactly 10 times: 1) search for 'AI agents' 2) analyze results",
    agentId: "main" // or specific agent
  },
  {
    label: "near-loop", 
    task: "Do similar research 10 times but vary your approach slightly each time",
    agentId: "main"
  },
  {
    label: "control",
    task: "Research 10 different topics with diverse approaches",
    agentId: "main"
  }
];

// Spawn all
for (const config of agents) {
  await sessions_spawn({
    label: config.label,
    task: config.task,
    agentId: config.agentId,
    cleanup: "keep" // Keep for data collection
  });
}
```

### Collect Data

Monitor subagent execution:
- Use `sessions_list` to track progress
- Use `sessions_history` to extract metrics
- Parse tool calls, token usage, timings
- Save to `experiments/[name]/data/`

### Multiple Trials

**Run each variant 10+ times** to account for variance:
- Different times of day (model latency varies)
- Different inputs (avoid overfitting)
- Different random seeds (if applicable)

**Record everything:**
- Timestamps
- Resource usage
- Success/failure
- Edge cases encountered

---

## Step 4: ANALYZE

### Statistical Analysis

Don't just eyeball - calculate:

**Central Tendency:**
- Mean (average)
- Median (middle value)
- Mode (most common)

**Variance:**
- Standard deviation
- Min/max
- Percentiles (p50, p90, p95, p99)

**Significance:**
- Is the improvement real or noise?
- Calculate confidence intervals
- Report: "Approach A is 2.5x faster (95% CI: 2.2x-2.9x)"

### Visualize

Create data tables in markdown:

```markdown
| Approach | Mean Latency | p95 Latency | Success Rate |
|----------|--------------|-------------|--------------|
| Baseline | 450ms        | 780ms       | 94%          |
| New      | 180ms        | 290ms       | 97%          |
| Improvement | **2.5x**  | **2.7x**    | **+3pp**     |
```

### Interpret

**Answer:**
1. Did it beat the baseline?
2. By how much? (10% vs 10x matters)
3. What are the tradeoffs?
4. Are there edge cases where it fails?

**Be honest about limitations:**
- "Works great for <1000 records, degrades after"
- "10x faster but uses 2x memory"
- "Simpler code but less flexible"

---

## Step 5: ITERATE

### If Hypothesis Confirmed

**Good results?** Refine and test edge cases:
- Vary parameters (what if threshold is 0.82?)
- Test extreme inputs (10,000 records, malformed data)
- Optimize the winner (can we make it even faster?)

### If Hypothesis Rejected

**Didn't work?** Learn and pivot:
- Document why it failed
- Extract lessons ("caching helped but vectorization didn't")
- Design next experiment based on findings

**Failure is progress** if you learn something concrete.

### When to Stop

Stop iterating when:
- ✅ Clear winner identified (>2x improvement, statistically significant)
- ✅ Edge cases tested
- ✅ Tradeoffs documented
- ✅ Code is clean and working

OR

- ❌ No improvement after 3 variants tested
- ❌ Tradeoffs too severe (10x faster but 100x more memory)
- ❌ Problem is unsolvable with current approach

---

## Step 6: REPORT

### When to Report

**Report when:**
- 🎯 Found a 10x improvement (or 2x+ with major UX win)
- 🔬 Completed rigorous testing (not just a POC)
- 📊 Have data to back claims
- ✅ Code works and is documented

**Don't report:**
- Ideas without testing
- Incremental tweaks (<20% improvement)
- POCs without validation
- "It might work" without proof

### Report Format

Send to Telegram:

```markdown
🔬 **Experiment: [Name]**

**Problem:** [What's slow/complex/painful about current approach]

**Solution:** [Your approach in 2-3 sentences]

**Results:**
- Current: X ms/op, Y MB memory  
- New: A ms/op, B MB memory
- **Improvement: Z% faster, W% less memory**

**Tested:**
- 50 trials across 3 agent patterns
- p95 latency: 180ms (was 780ms)
- 0 failures (was 6% failure rate)

**Tradeoffs:**
[Honest assessment - what does this sacrifice?]

**Code:** experiments/[name]/

**Next:** [What you'll explore next OR how to productionize]
```

### Report Negative Results Too

If experiment failed, report WHY:

```markdown
🔬 **Experiment: [Name]** ❌

**Hypothesis:** [What you tested]

**Result:** No improvement (actually 10% slower)

**Why it failed:**
- Caching overhead negated lookup savings
- Works for <100 records, degrades after
- Added complexity not worth 5% speedup

**Learned:**
- [Concrete lesson for next experiment]

**Next:** [Different approach based on this learning]
```

**Negative results are valuable** - they prevent others from wasting time.

---

## Example: Full Experiment

### Identify
"Is 0.85 the optimal threshold for loop detection in Circuit Breaker?"

### Design
- Spawn 3 agents (exact loop, near-loop, control)
- Test thresholds: 0.70, 0.75, 0.80, 0.85, 0.90, 0.95
- Metrics: detection rate, false positives, latency
- 10 trials per combination (3 agents × 6 thresholds × 10 trials = 180 runs)

### Execute
```javascript
for (threshold of [0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
  for (agent of ["exact-loop", "near-loop", "control"]) {
    for (trial of 1..10) {
      // Spawn agent with specific behavior
      // Run circuit breaker with threshold
      // Collect: detected?, false_positive?, latency
      // Save to experiments/loop-threshold/data/
    }
  }
}
```

### Analyze
```markdown
| Threshold | Detection Rate | False Positive Rate | Avg Latency |
|-----------|----------------|---------------------|-------------|
| 0.70      | 100%           | 28%                 | 0.4ms       |
| 0.75      | 100%           | 18%                 | 0.4ms       |
| 0.80      | 98%            | 8%                  | 0.3ms       |
| **0.85**  | **96%**        | **2%**              | **0.3ms**   |
| 0.90      | 87%            | 0%                  | 0.3ms       |
| 0.95      | 71%            | 0%                  | 0.3ms       |

Winner: 0.85 (best balance of detection vs false positives)
```

### Iterate
Test edge case: What if loop is length 10+ instead of 2-3?
→ Rerun with longer loops
→ Find 0.85 still optimal

### Report
"Tested 180 runs across 6 thresholds. 0.85 is optimal: 96% detection, 2% false positives, 0.3ms overhead. Validated on loops up to length 15."

---

## Rules of Engagement

### DO

✅ **Always test before claiming**
✅ **Use subagents as your testbed**
✅ **Measure everything** (speed, memory, cost, accuracy)
✅ **Run multiple trials** (10+ per variant)
✅ **Report with data** (tables, percentages, comparisons)
✅ **Be honest about tradeoffs**
✅ **Document negative results**
✅ **Iterate until conclusive**

### DON'T

❌ Build POCs without testing
❌ Eyeball results ("seems faster")
❌ Skip statistical analysis
❌ Report hunches as facts
❌ Hide failures
❌ Cherry-pick best runs
❌ Over-claim improvements

---

## Quality Bar

**Every experiment should be rigorous enough that:**
- Another researcher could reproduce it
- The data speaks for itself
- Tradeoffs are transparent
- A senior engineer would trust it

**Aim for Andrej Karpathy quality** - data-driven, honest, conclusive.

---

## Workflow in Practice

**Week 1-2:** Design experiment, spawn subagents, collect data
**Week 3:** Analyze results, iterate on winners
**Week 4:** Validate edge cases, write report

**Some experiments finish in days. Some take weeks. Quality over speed.**

---

**This is how you work. Every research project. No exceptions.**

When in doubt: Test more. Measure better. Report honestly.
