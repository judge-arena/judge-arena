# Judge Arena Review Findings

## CRITICAL (fix immediately)
- [x] 1. `middleware.ts:49-55` - IP spoofing bypasses all rate limiting
- [x] 2. `auth/register/route.ts` - Registration rate limiter never wired up
- [x] 3. `auth/register/route.ts:19-24` - User enumeration via distinct 409 error
- [x] 4. `crypto.ts:92-98` - `decryptSafe` silently returns ciphertext on failure

## HIGH (fix soon)
- [x] 5. `evaluation-run-manager.ts:126-249` - Runs stuck in `judging` forever
- [x] 6. `llm/provider.ts:123-160` - Prompt injection via user text
- [x] 7. `llm/index.ts` / `resilience.ts` - Circuit breaker scoped by provider name, not endpoint
- [x] 8. `crypto.ts:75-77` - `isEncrypted` false positives
- [x] 9. `evaluations/route.ts:458-464` - IDOR on datasets
- [x] 10. `evaluations/[id]/route.ts:102-105` - IDOR on rubrics
- [x] 11. `schema.prisma:121-122,169-170` - Missing `onDelete: SetNull` on Rubric FK
- [x] 12. `realtime/redis-bus.ts:100-103` - Redis bus marked initialized on failure

## MEDIUM
- [x] 13. `llm/provider.ts:199` - `||` vs `??` for overallScore
- [x] 14. `llm/provider.ts:183-185` - Criteria matching by exact name
- [x] 15. `evaluation-run-manager.ts:286-293` - No queue deduplication
- [x] 16. `evaluation-run-manager.ts:255-278` - Queue errors swallowed silently
- [x] 17. `anthropic.ts` vs `openai-compatible.ts` - Temperature inconsistency
- [x] 18. `anthropic.ts:55-56` - No bounds check on response.content[0]
- [x] 19. `middleware.ts:66` - CSP allows unsafe-inline/unsafe-eval
- [x] 20. `datasets/[id]/samples/route.ts:268-288` - Non-atomic bulk replace
- [x] 21. `rubrics/[id]/route.ts:82-108` - Non-atomic criteria replace
- [x] 22. `model-judgment-card.tsx:169-178` - Division by zero
- [x] 23. `human-judgment-form.tsx:37-56` - Form doesn't re-sync
- [x] 24. `schema.prisma:229` - selectedBestModelId no FK
- [x] 25. `evaluations/route.ts:87-135` - Unbounded nested includes
- [x] 26. `resilience.ts:200-206` - Retry inside circuit breaker
- [x] 27. `realtime/redis-bus.ts:120-124` - new Function is eval
- [x] 28. `rate-limit.ts:129-130` - X-RateLimit-Limit header wrong

## LOW
- [x] 29. Provider registry case-sensitive
- [ ] 30. New client on every call — deferred (requires restructuring provider classes)
- [ ] 31. Keyboard 0 maps to score 10 — intentional UX (0 key = 10/10)
- [ ] 32. Dashboard empty state vs login redirect — deferred
- [ ] 33. No updatedAt on ModelJudgment/DatasetSample — deferred (schema migration)
- [ ] 34. Health endpoint leaks error messages — N/A (no health endpoint exists)
- [ ] 35. JWT maxAge 30 days no rotation — deferred (auth config)
- [ ] 36. Dashboard data never refreshed — deferred (SWR/polling enhancement)

## FEATURES
- [x] F1. Public leaderboard mode
- [ ] F2. CI/CD integration endpoint
- [ ] F3. Multi-judge aggregation (Cohen's kappa)
- [ ] F4. Structured output for LLM responses
- [ ] F5. Background job processing (BullMQ)
- [ ] F6. Team/RBAC support
