export interface ChatTurn {
  role: 'caller' | 'receptionist';
  text: string;
}

export interface CallState {
  turn: number;
  misses: number;
  history: ChatTurn[];
}

const MAX_HISTORY = 30;

export class CallStore {
  private calls = new Map<string, CallState>();

  reset(callSid: string): CallState {
    const state: CallState = { turn: 0, misses: 0, history: [] };
    this.calls.set(callSid, state);
    return state;
  }

  get(callSid: string): CallState {
    let state = this.calls.get(callSid);
    if (!state) {
      state = { turn: 0, misses: 0, history: [] };
      this.calls.set(callSid, state);
    }
    return state;
  }

  pushHistory(callSid: string, turn: ChatTurn): void {
    const state = this.get(callSid);
    state.history.push(turn);
    if (state.history.length > MAX_HISTORY) {
      state.history.splice(0, state.history.length - MAX_HISTORY);
    }
  }
}
