/**
 * A Server-Sent Events parser.
 *
 * Pure and streaming: bytes go in as strings, complete events come out. It
 * implements the parts of the WHATWG event-stream format the Core's stream
 * uses — `id`, `event`, `data`, comment lines (a heartbeat is `: …`), multiple
 * `data` lines joined with `\n`, and a blank line as the dispatch separator.
 * Lines may end in `\n`, `\r\n` or `\r`; a field's value loses exactly one
 * leading space after the colon.
 *
 * A trailing block without its closing blank line is discarded at end of
 * stream, as the format requires.
 */

export type SseEvent = {
  /** Present only when the block declared an `id` field; may be empty (a reset). */
  readonly id?: string;
  /** Present only when the block declared an `event` field. */
  readonly event?: string;
  /** The `data` lines joined with `\n`. Never absent on a dispatched event. */
  readonly data: string;
};

export class SseParser {
  #buffer = "";
  #dataLines: string[] = [];
  #eventType: string | undefined = undefined;
  #eventId: string | undefined = undefined;

  /** Feeds a chunk and returns every event completed by it. */
  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const breakIndex = findLineBreak(this.#buffer);
      if (breakIndex === null) break;
      const line = this.#buffer.slice(0, breakIndex.start);
      this.#buffer = this.#buffer.slice(breakIndex.end);
      const event = this.#consumeLine(line);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** Discards any partial trailing block; the format drops it at end of stream. */
  end(): SseEvent[] {
    this.#buffer = "";
    this.#reset();
    return [];
  }

  #consumeLine(line: string): SseEvent | null {
    if (line === "") return this.#dispatch();
    if (line.startsWith(":")) return null; // comment — a heartbeat, for instance
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    switch (field) {
      case "data":
        this.#dataLines.push(value);
        return null;
      case "event":
        this.#eventType = value;
        return null;
      case "id":
        this.#eventId = value;
        return null;
      default:
        return null; // `retry` and unknown fields are ignored
    }
  }

  #dispatch(): SseEvent | null {
    if (this.#dataLines.length === 0) {
      // No data means no event is dispatched, even if `id`/`event` were seen.
      this.#reset();
      return null;
    }
    const event: SseEvent = {
      data: this.#dataLines.join("\n"),
      ...(this.#eventId !== undefined ? { id: this.#eventId } : {}),
      ...(this.#eventType !== undefined ? { event: this.#eventType } : {}),
    };
    this.#reset();
    return event;
  }

  #reset(): void {
    this.#dataLines = [];
    this.#eventType = undefined;
    this.#eventId = undefined;
  }
}

/** The first line break in `text`, and how many characters it spans. */
function findLineBreak(text: string): { start: number; end: number } | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return { start: index, end: index + 1 };
    if (char === "\r") {
      const next = text[index + 1];
      // A `\r` at the very end may still be the first half of a `\r\n`: wait.
      if (next === undefined) return null;
      return { start: index, end: next === "\n" ? index + 2 : index + 1 };
    }
  }
  return null;
}
