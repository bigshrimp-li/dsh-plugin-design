/**
 * DSH renders one assistant node per (turn, step). Core message identity must
 * therefore own a position, even when several responses belong to one Run.
 * The durable DSH events restore both identities and the numbering high-water
 * marks; process-local live frames reserve the same position as their message.
 */
export class MessagePositions {
  constructor(history = []) {
    this.positions = new Map();
    this.lastSteps = new Map();
    this.coreTurns = new Map();
    this.turnOwners = new Map();
    this.toolGroups = new Map();
    this.toolCalls = new Map();
    this.lastTurn = 0;
    for (const event of history) {
      const { turn, step } = event?.data ?? {};
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 1) continue;
      this.lastSteps.set(turn, Math.max(step, this.lastSteps.get(turn) ?? 0));
      this.lastTurn = Math.max(this.lastTurn, turn);
      const id = event.data?.message?.id;
      if (typeof id === "string") this.positions.set(id, { turn, step });
      if (event.type === "tool/call" && typeof event.data?.callId === "string") {
        this.toolCalls.set(event.data.callId, { turn, step });
      }
    }
  }

  bindCoreTurn(id, coreTurnId) {
    const held = this.positions.get(id);
    if (held && coreTurnId) {
      this.coreTurns.set(coreTurnId, held.turn);
      this.turnOwners.set(held.turn, coreTurnId);
    }
  }

  claim(id, turn, firstStep = 1, coreTurnId = null) {
    const held = this.positions.get(id);
    if (held !== undefined) {
      this.bindCoreTurn(id, coreTurnId);
      return held;
    }
    if (coreTurnId) {
      if (this.coreTurns.has(coreTurnId)) {
        turn = this.coreTurns.get(coreTurnId);
      } else {
        // DSH Chat folds intermediate steps. Distinct Core Turns must also
        // have distinct DSH turns so a next_turn answer stays visible.
        if (this.turnOwners.has(turn) || this.lastSteps.has(turn)) {
          turn = Math.max(turn, this.lastTurn) + 1;
        }
        this.coreTurns.set(coreTurnId, turn);
        this.turnOwners.set(turn, coreTurnId);
      }
    }
    this.lastTurn = Math.max(this.lastTurn, turn);
    const step = Math.max(firstStep - 1, this.lastSteps.get(turn) ?? 0) + 1;
    const position = { turn, step };
    this.positions.set(id, position);
    this.lastSteps.set(turn, step);
    return position;
  }

  /** All parallel calls advertised by one assistant, and their results, must
   * settle in one DSH step. A result cannot be moved into a later step. */
  claimTool(id, message, turn, firstStep = 1) {
    const callId = message.toolCallId;
    const group = message.turnId || (message.entryId == null ? null : `entry:${message.entryId}`);
    let position = this.toolCalls.get(callId);
    if (!position && message.kind === "tool_call" && group) position = this.toolGroups.get(group);
    if (!position) position = this.claim(id, turn, firstStep, message.turnId);
    this.positions.set(id, position);
    if (callId) this.toolCalls.set(callId, position);
    if (message.kind === "tool_call" && group) this.toolGroups.set(group, position);
    this.bindCoreTurn(id, message.turnId);
    return position;
  }
}
