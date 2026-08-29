export type PrefixedBody = {
  prefix: Uint8Array;
  stream: ReadableStream<Uint8Array>;
};

export function contentLengthOf(request: Request): number | null {
  const raw = request.headers.get("Content-Length");
  if (raw === null || raw === "") {
    return null;
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) {
    return null;
  }
  return length;
}

export function toFixedLengthStream(
  stream: ReadableStream<Uint8Array>,
  length: number,
): { readable: ReadableStream<Uint8Array>; done: Promise<void> } {
  const fixed = new FixedLengthStream(length);
  return {
    readable: fixed.readable,
    done: stream.pipeTo(fixed.writable),
  };
}

export async function takePrefix(
  body: ReadableStream<Uint8Array> | ReadableStream | null,
  size: number,
): Promise<PrefixedBody> {
  if (body === null) {
    return { prefix: new Uint8Array(), stream: emptyStream() };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < size) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    received += chunk.byteLength;
  }
  const buffered = concatBytes(chunks);
  const prefix = buffered.byteLength <= size ? buffered : buffered.slice(0, size);
  return { prefix, stream: chainStream(buffered, reader) };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function chainStream(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let sentHead = false;
  return new ReadableStream({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        if (head.byteLength > 0) {
          controller.enqueue(head);
          return;
        }
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      const chunk = next.value instanceof Uint8Array
        ? next.value
        : new Uint8Array(next.value);
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}