# Echo Functional Acceptance

Date: 2026-07-07

Environment:
- isolated backend instance on `http://localhost:3101`
- isolated database at `data/acceptance/echo-acceptance.sqlite`
- provider: `local`

## Goal

Verify that the current product logic works end to end before moving on to UI optimization.

## Scenarios Checked

### 1. Initial entry

Expected:
- empty state is stable
- no active learning or action queue is required to load `/state`
- system falls back to opening a conversation

Observed:
- `/state` returned a stable empty shape
- `current_state.emotion = neutral`
- `next_action.type = open_conversation`

Result: pass

### 2. General chat

Expected:
- `/chat` returns a reply
- memory and state update after the message
- no accidental learning flow is created from ordinary chat

Observed:
- reply returned successfully
- state remained coherent after the chat
- no forced learning session was created from a plain general message

Result: pass

### 3. Start a learning line

Expected:
- learning intent creates or resumes a learning session
- `/learning/active` exposes the page-ready learning view model
- `/state.next_action` points to the current learning step

Observed:
- English learning input created a session successfully
- `/learning/active` returned a current session and current step
- `/state.next_action.type = continue_learning`

Result: pass

Notes:
- topic extraction is too literal right now
- input: `I want to learn JavaScript. Help me study.`
- extracted topic: `JavaScript. Help me study`
- expected topic should be closer to just `JavaScript`

### 4. Learning stuck

Expected:
- a stuck message should log a stuck event
- state should keep the user on the active learning line

Observed:
- `step_stuck` event was recorded
- state still pointed to the current learning step

Result: pass

### 5. Learning completion

Expected:
- an explicit completion message advances to the next step

Observed:
- explicit completion in English advanced the session from step 0 to step 1
- current learning step changed from “say what it is” to “make a tiny example”

Result: pass

### 6. Suggested action and action activation

Expected:
- suggested actions can be created from the current state
- only one action should stay `active` at a time
- `/state.current_action` should reflect the active task

Observed:
- suggested action created successfully
- action activation succeeded
- `/state.current_action` matched the active action

Result: pass

### 7. Daily summary

Expected:
- summary can be generated from current memory and learning events
- recent summaries are readable from `/summary/recent`

Observed:
- summary generation succeeded
- recent summary list and current reflection were available

Result: pass

### 8. Memory pin and recall

Expected:
- a memory can be pinned
- pinned memory should become high-priority recall context

Observed:
- pin succeeded
- memory moved to `priority_bucket = core`
- `/memory/context` returned relevant recalled memories and prompt context

Result: pass

### 9. TTS unavailable state

Expected:
- when `SILICONFLOW_API_KEY` is missing, `/tts` should fail clearly

Observed:
- `/tts` returned `502`
- error code: `tts_not_configured`

Result: pass

## Real Findings

### F1. Active learning session can misclassify unrelated chat as learning progress

Severity: medium

What happened:
- after a learning session was active, sending an unrelated message like
  `I feel tired today and I just want to talk a little.`
- still produced a new `step_attempted` learning event

Why it matters:
- ordinary emotional conversation can accidentally mutate the learning timeline
- learning progress becomes noisy and less trustworthy
- the product may overstate continuity when the user has actually switched context

Likely cause:
- `assessLearningProgress()` in `src/services/learningEngine.js` treats any sufficiently long reply as `partial`
- this runs whenever there is a latest active learning session, even if the message is not actually about the learning task

### F2. Topic extraction is overly broad

Severity: medium

What happened:
- learning topic became `JavaScript. Help me study`

Why it matters:
- step titles become awkward
- summaries and memory notes become less natural
- later retrieval and UI copy become noisier than necessary

Likely cause:
- topic extraction is pulling too much surrounding phrasing instead of isolating the core subject

## Important Context

Some Windows shell-based API checks can garble direct Chinese request text when the request body is piped through the terminal layer.

To avoid confusing that with product logic:
- direct function-level checks for `analyzeInput()` and `classifyLearningReply()` were also run
- those direct checks correctly handled Chinese learning, stuck, and completion phrases

So the strongest product-level findings from this acceptance run are:
- the main logic chain works
- learning continuity is functional
- action, summary, memory, and TTS fallback logic are coherent
- the most important logic risk is unrelated chat being counted as learning progress

## Recommendation

Before UI optimization, prioritize:

1. tighten learning-progress gating so only learning-relevant messages mutate the learning session
2. improve topic extraction so learning subjects are cleaner and more reusable across state, memory, and UI copy
