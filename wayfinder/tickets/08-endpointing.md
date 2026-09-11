---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [07-stream-session-skeleton.md]
assignee:
---

# 08: Endpointing — reply only after the Caller stops

**What to build:** inbound caller audio produces utterance events exactly per the Endpointing policy — trailing silence ends the utterance, sub-minimum noises never start one, overlong speech is force-ended, and audio arriving while reply audio plays is discarded so the Receptionist never talks over the Caller (no barge-in).

**Blocked by:** 07 (needs the Stream session and fake driver).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Trailing-silence duration ends the utterance; brief mid-sentence pauses do not.
- [ ] Coughs/short noises below the minimum speech length are ignored, not treated as utterances.
- [ ] An utterance hitting the maximum duration is force-ended.
- [ ] Inbound audio during reply playback is discarded; the endpoint timer starts only after playback completes.
- [ ] All of the above verified through the fake driver with synthetic speech/silence patterns; no STT/LLM/TTS involved.
