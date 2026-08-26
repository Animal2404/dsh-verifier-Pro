# deep_review —— 深度审查预设（目录版，优先于代码内置；删除本文件即回退内置）

## RootCause
Does it identify the ACTUAL root cause, pinning its specific location (code excerpt / log line / metric / step number)? Restating symptoms, or a generic list of possible causes without one pinned location, scores LOW.

## Evidence
Are the key claims backed by QUOTED evidence — exact code lines, raw command output, measured numbers — rather than paraphrase? Any load-bearing claim without a quotable anchor scores LOW.

## FailureModes
Name at least one NON-OBVIOUS edge case or failure mode (races, resource limits, security, encoding…) AND show concretely how the design handles it. A bare "edge cases are handled" claim with no named instance scores LOW.

## Tradeoffs
Name the STRONGEST alternative approach and explain concretely why it loses. "Tradeoffs were considered" without naming one scores LOW.

## Actionability
Are the next steps executable AND verifiable exactly as written (precise change, precise check)? Generic advice ("add more tests", "improve error handling") scores LOW.
