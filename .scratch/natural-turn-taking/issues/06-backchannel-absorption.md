# 06: Backchannel absorption

**What to build:** Short Caller acknowledgements while the Receptionist speaks ("mm-hmm", "okay", "right") are heard, classified as Backchannels, and do not stop it. Energy is the fast pre-trigger; partial transcription semantics confirm. A Backchannel never becomes a Turn and never enters LLM history — it is absorbed and traced only.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] Scripted Backchannels during playback do not stop the Receptionist and leave history unchanged; traces record the absorption.
- [ ] Backchannels are distinguished from short content-bearing interruptions ("wait", "no, Monday") in scripted scenarios.
- [ ] Genuine Barge-in still fires on content-bearing speech while the Receptionist speaks.
- [ ] The Caller hears no gap or acknowledgement reply to a Backchannel.
